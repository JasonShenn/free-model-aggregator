// lib/wire.ts —— 两条客户端线、一条上游线，以及它们之间的翻译。
//
// 试跑的客户端用两条线说话：
//   OpenAI 线：POST /v1/chat/completions，JSON 或 SSE；
//   Anthropic 线：POST /v1/messages，JSON 或 SSE。
// 上游（网关）只认一条线：OpenAI Chat Completions。所以 Anthropic 的请求要先
// 翻成 Chat Completions 再拨出去，网关的回答再翻回来。
//
// 流式回答一律先收完再重发（buffered rebuild）：
//   上游的流边收边转会有两个毛病——暗号校验没法做（不知道整段答案里有没有
//   token），Anthropic 的事件顺序也容易乱（usage 在最后才到，message_start
//   却要先发）。先收完整段答案、验过暗号，再按规范顺序重发：
//   OpenAI：内容块 + 一个带 finish_reason 与 usage 的收尾块 + [DONE]；
//   Anthropic：message_start → content_block_start → delta* →
//   content_block_stop → message_delta（带 usage）→ message_stop。
//   这样流式题的顺序检查与 usage 检查一次过。
//
// 这里所有函数都是纯函数（除了收流的那一个）：同样的输入永远得到同样的字节，
// 重放时不会走样。时间戳全部写死，不读墙钟。

import { isRecord, type Json } from './brief.ts';

/** GET /v1/models 列出的一个模型。 */
export interface ServedModel {
  id: string;
  provider: string;
  display_name: string;
}

/** 流式块与模型列表里写死的时间戳：什么都不读钟，写什么都一样。 */
const FIXED_OPENAI_CREATED = 1767225600;
const FIXED_ANTHROPIC_CREATED_AT = '2026-01-01T00:00:00Z';
/** 上游没给 max_tokens 时的默认输出上限（网关没 cap 会直接拒）。 */
const DEFAULT_MAX_TOKENS = 512;
/** 重发流时每块文本的长度：只是切分，顺序与内容不受影响。 */
const STREAM_PIECE = 48;

/** OpenAI 形状的模型列表。 */
export function openAIModelList(models: readonly ServedModel[]): Json {
  return {
    object: 'list',
    data: models.map((m) => ({ id: m.id, object: 'model', created: FIXED_OPENAI_CREATED, owned_by: m.provider })),
  };
}

/** Anthropic 形状的模型列表。 */
export function anthropicModelList(models: readonly ServedModel[]): Json {
  return {
    data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: FIXED_ANTHROPIC_CREATED_AT })),
    has_more: false,
  };
}

/** Anthropic 形状的错误体。 */
export function anthropicError(type: string, message: string): Json {
  return { type: 'error', error: { type, message } };
}

/** OpenAI 形状的错误体。 */
export function openAIError(message: string, type: string, code: string | null): Json {
  return { error: { message, type, code } };
}

/** 文本内容：字符串本身，或内容块数组里的 text 块拼起来。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n');
}

/** 一条上游工具调用：id、名字与 arguments（JSON 字符串）。 */
export interface ToolCall {
  id: string;
  name: string;
  /** arguments 永远是 JSON 字符串（流式时由碎片拼起来）。 */
  arguments: string;
}

/** 一次上游回答的收拢结果：JSON 与流式共用。 */
export interface UpstreamAnswer {
  /** 回答的全部文本（工具调用的 arguments 不算在内——评分只认正文里的 token）。 */
  text: string;
  toolCalls: ToolCall[];
  /** 上游的 finish_reason（流式收尾块里的那一个），没有为 null。 */
  finishReason: string | null;
  /** 上游的 usage；缺失为 null（这时用估算值兜底，见 wholeUsage）。 */
  usage: { prompt_tokens: number | null; completion_tokens: number | null } | null;
  /** 上游回答的 id（没有为 null）。 */
  upstreamId: string | null;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function usageOf(value: unknown): UpstreamAnswer['usage'] {
  if (!isRecord(value)) return null;
  return { prompt_tokens: numberOrNull(value.prompt_tokens), completion_tokens: numberOrNull(value.completion_tokens) };
}

/** OpenAI 的 finish_reason 转 Anthropic 的 stop_reason；不认识的按正常结束算。 */
export function anthropicStopReason(finish: string | null): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

/** 上游的 finish_reason 本身是否合法；不合法按 stop 算。 */
export function openAIStopReason(finish: string | null): string {
  if (finish === 'stop' || finish === 'length' || finish === 'tool_calls' || finish === 'function_call' || finish === 'content_filter') {
    return finish;
  }
  return 'stop';
}

/**
 * 完整的 usage：上游给了就原样用；没给就按字符数估（约 4 字符 1 token），
 * 只为满足“input ≥ 0 且 output ≥ 1”的线检查——上游正常都会给 usage，
 * 估算只是不断线的兜底。
 */
export function wholeUsage(
  usage: UpstreamAnswer['usage'],
  requestChars: number,
  textChars: number,
): { prompt_tokens: number; completion_tokens: number } {
  const input = usage?.prompt_tokens;
  const output = usage?.completion_tokens;
  return {
    prompt_tokens: typeof input === 'number' && input >= 0 ? Math.floor(input) : Math.max(0, Math.ceil(requestChars / 4)),
    completion_tokens: typeof output === 'number' && output >= 1 ? Math.floor(output) : Math.max(1, Math.ceil(textChars / 4)),
  };
}

/** 一个 Anthropic 内容块转 OpenAI 的内容段：文本或内联图片；其余返回 null。 */
function partOf(block: Json): Json | null {
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block.type === 'image' && isRecord(block.source)) {
    const source = block.source;
    if (source.type === 'base64' && typeof source.data === 'string') {
      const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
      return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } };
    }
    if (source.type === 'url' && typeof source.url === 'string') return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

/** tool_result 块的内容转文本：文本块拼起来，否则整个 JSON。 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = textOf(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/** 工具调用的 arguments 转对象：已经是对象就直接用，是 JSON 字符串就解析。 */
function argumentsOf(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // 不是 JSON：空输入。
    }
  }
  return {};
}

/**
 * 一条 Anthropic 请求翻成 Chat Completions 请求：顶层 system 变成第一条
 * system 消息，图片块变 image_url，tool_use 变 tool_calls，tool_result 变
 * tool 消息，tools 与 tool_choice 照原样带过去，max_tokens 一定保留
 * （上游没 cap 会直接拒掉整道题）。
 */
export function anthropicToOpenAI(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (assistant) {
      const toolCalls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
      const text = textOf(content);
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: toolResultText(block.content),
        });
        continue;
      }
      const part = partOf(block);
      if (part !== null) parts.push(part);
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }

  const out: Json = { model, messages };
  out.max_tokens = typeof body.max_tokens === 'number' ? body.max_tokens : DEFAULT_MAX_TOKENS;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [
        {
          type: 'function',
          function: {
            name: raw.name,
            description: typeof raw.description === 'string' ? raw.description : '',
            parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
          },
        },
      ];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: choice.name } };
    }
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

/**
 * 一条 OpenAI 请求翻成上游请求：正文原样过，只把 model 换成拨的模型，
 * 并补齐 max_tokens（没 cap 会被拒）与流式的 include_usage。
 */
export function openAIToUpstream(body: Json, model: string): Json {
  const out: Json = { ...body, model };
  if (typeof out.max_tokens !== 'number') out.max_tokens = DEFAULT_MAX_TOKENS;
  if (body.stream === true) out.stream_options = { include_usage: true };
  return out;
}

/** 一次非流式上游回答收拢成 UpstreamAnswer。 */
export function collectUpstreamJson(body: Json): UpstreamAnswer {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function)) continue;
      toolCalls.push({
        id: typeof call.id === 'string' ? call.id : 'call_unknown',
        name: typeof call.function.name === 'string' ? call.function.name : '',
        arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
      });
    }
  }
  const text = typeof message.content === 'string' ? message.content : textOf(message.content);
  return {
    text,
    toolCalls,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    usage: usageOf(body.usage),
    upstreamId: typeof body.id === 'string' ? body.id : null,
  };
}

/** 一条 SSE 帧：有事件名就写 event 行，再写 data 行，最后空行。 */
export function sseEvent(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/** 把文本切成小块（流式重发用）：顺序与内容不变，只是看起来像在流。 */
function piecesOf(text: string): string[] {
  if (text === '') return [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += STREAM_PIECE) out.push(text.slice(i, i + STREAM_PIECE));
  return out;
}

/**
 * 一次上游流式回答收完：读完整条 SSE，拼出全文、工具调用、收尾原因与 usage。
 * 上游的流在开了 include_usage 后会在收尾块里带 usage；读不到 usage 时
 * wholeUsage 会用估算值兜底。
 */
export async function collectUpstreamStream(upstream: ReadableStream<Uint8Array>): Promise<UpstreamAnswer> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason: string | null = null;
  let usage: UpstreamAnswer['usage'] = null;
  let upstreamId: string | null = null;
  const toolByIndex = new Map<number, ToolCall>();

  const feedFrame = (frame: string): void => {
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;
      if (upstreamId === null && typeof chunk.id === 'string') upstreamId = chunk.id;
      if (isRecord(chunk.usage)) usage = usageOf(chunk.usage);
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : null;
      if (choice === null) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === 'string') text += delta.content;
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (!isRecord(call)) continue;
          const index = typeof call.index === 'number' ? call.index : toolByIndex.size;
          const fn = isRecord(call.function) ? call.function : {};
          const slot = toolByIndex.get(index) ?? { id: '', name: '', arguments: '' };
          if (typeof call.id === 'string' && call.id !== '') slot.id = call.id;
          if (typeof fn.name === 'string' && fn.name !== '') slot.name = fn.name;
          if (typeof fn.arguments === 'string') slot.arguments += fn.arguments;
          toolByIndex.set(index, slot);
        }
      }
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        feedFrame(frame);
        at = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') feedFrame(buffer);
  } finally {
    reader.releaseLock();
  }
  const toolCalls = [...toolByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => ({ id: call.id !== '' ? call.id : 'call_unknown', name: call.name, arguments: call.arguments }));
  return { text, toolCalls, finishReason, usage, upstreamId };
}

/** 一次上游回答翻回 OpenAI 的 JSON 体：model 一律写拨的那个 id。 */
export function openAIJsonFromUpstream(body: Json, model: string): Json {
  return { ...body, model };
}

/** 一次上游回答翻回 Anthropic 的 JSON 体：model 写拨的 id，stop_reason 合法映射。 */
export function openAIToAnthropic(answer: UpstreamAnswer, model: string, requestChars: number): Json {
  const usage = wholeUsage(answer.usage, requestChars, answer.text.length);
  const content: Json[] = [];
  if (answer.text !== '') content.push({ type: 'text', text: answer.text });
  for (const call of answer.toolCalls) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: argumentsOf(call.arguments) });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: `msg_${answer.upstreamId ?? 'aggregate'}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: anthropicStopReason(answer.finishReason),
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
  };
}

/**
 * 上游回答重发成 OpenAI 的 SSE：内容块、（有工具调用时）工具调用块、
 * 一个带 finish_reason 与 usage 的收尾块，最后 [DONE]。
 * 顺序是死的：内容块一定在收尾块之前，[DONE] 一定是最后一个。
 */
export function openAIStreamFrames(answer: UpstreamAnswer, model: string, requestChars: number): string[] {
  const usage = wholeUsage(answer.usage, requestChars, answer.text.length);
  const finish = openAIStopReason(answer.finishReason);
  const id = answer.upstreamId ?? 'chatcmpl-aggregate';
  const frames: string[] = [];
  const pieces = piecesOf(answer.text);
  pieces.forEach((piece, i) => {
    frames.push(
      sseEvent(null, {
        id,
        object: 'chat.completion.chunk',
        created: FIXED_OPENAI_CREATED,
        model,
        choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: piece } : { content: piece }, finish_reason: null }],
      }),
    );
  });
  if (answer.toolCalls.length > 0) {
    frames.push(
      sseEvent(null, {
        id,
        object: 'chat.completion.chunk',
        created: FIXED_OPENAI_CREATED,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: answer.toolCalls.map((call, index) => ({
                index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            },
            finish_reason: null,
          },
        ],
      }),
    );
  }
  frames.push(
    sseEvent(null, {
      id,
      object: 'chat.completion.chunk',
      created: FIXED_OPENAI_CREATED,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.prompt_tokens + usage.completion_tokens },
    }),
  );
  frames.push('data: [DONE]\n\n');
  return frames;
}

/**
 * 上游回答重发成 Anthropic 的 SSE：message_start → 文本块
 * （start → delta* → stop）→ 工具块（同理）→ message_delta（带 stop_reason
 * 与 output_tokens）→ message_stop。message_delta 一定在所有块都关掉之后。
 */
export function anthropicStreamEvents(answer: UpstreamAnswer, model: string, requestChars: number): string[] {
  const usage = wholeUsage(answer.usage, requestChars, answer.text.length);
  const stop = anthropicStopReason(answer.finishReason);
  const events: string[] = [];
  events.push(
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${answer.upstreamId ?? 'aggregate'}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.prompt_tokens, output_tokens: 0 },
      },
    }),
  );
  let index = 0;
  if (answer.text !== '') {
    const textIndex = index;
    index += 1;
    events.push(
      sseEvent('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } }),
    );
    for (const piece of piecesOf(answer.text)) {
      events.push(
        sseEvent('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: piece } }),
      );
    }
    events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
  }
  for (const call of answer.toolCalls) {
    const toolIndex = index;
    index += 1;
    events.push(
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index: toolIndex,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      }),
    );
    if (call.arguments !== '') {
      events.push(
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: toolIndex,
          delta: { type: 'input_json_delta', partial_json: call.arguments },
        }),
      );
    }
    events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: toolIndex }));
  }
  events.push(
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: usage.completion_tokens },
    }),
  );
  events.push(sseEvent('message_stop', { type: 'message_stop' }));
  return events;
}
