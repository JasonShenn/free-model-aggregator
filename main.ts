// free-model-aggregator：一个服务器，两条线，十四 个免费模型。
//
// 客户端指过来就能用：OpenAI 的 POST /v1/chat/completions 与 Anthropic 的
// POST /v1/messages，JSON 与流式都接；每道题的答案都来自一个真正的免费模型，
// 经试跑网关拨 OpenRouter 拨回来，绝不是本机编的。
//
// 路由（见 lib/router.ts）：按评分排梯队——主力是 Super VL（1303）与
// Ultra（1285），Lightning、Gemma 31B、North Mini 与 8 个 1150 档全部在链上，
// Inkling（1475）只放最后当彩票；网关拒答就换下一个，答案里没有暗号 token
// 也换下一个（白答不算数）；拒答两次的模型本场不再点。
//
// 确定性：一切选择只取决于简报、请求与网关已经给过的回答。不读墙钟，
// 不用无种子随机——上游调用也不设超时：超时是墙钟决定，正式跑时触发了、
// 重放时（网关直接从录像带里回答案）不触发，两条路一走岔，重放就对不上。
// 每道题最多试 3 个模型，试完还没答出来就认 502， trial 继续走。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  freeModels,
  isRecord,
  readBrief,
  type CatalogReport,
  type Json,
} from './lib/brief.ts';
import { MAX_ATTEMPTS, Router, requirementsFromBody, tokenOfBody } from './lib/router.ts';
import {
  anthropicError,
  anthropicModelList,
  anthropicStreamEvents,
  anthropicToOpenAI,
  collectUpstreamJson,
  collectUpstreamStream,
  openAIError,
  openAIJsonFromUpstream,
  openAIStreamFrames,
  openAIToAnthropic,
  openAIModelList,
  openAIToUpstream,
  type ServedModel,
} from './lib/wire.ts';

/** 注册体里的协议版本。 */
const PROTOCOL_VERSION = 1;
/** GET /work 的轮询间隔（毫秒）：只决定多久问一次，不决定任何事。 */
const POLL_INTERVAL_MS = 100;
/** 一条客户端请求正文最多读多少字节。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** 注册失败时立即重发几次（注册不进评分状态，重发不影响重放）。 */
const REGISTER_RETRIES = 3;
/** 一次注册调用最多等多久。 */
const REGISTER_TIMEOUT_MS = 5000;
/** 拒答轨迹的响应头：网关拒了、我方重试后答出来的唯一凭证。 */
const FAILURES_HEADER = 'x-makefun-upstream-failures';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** 试跑的替身 key：网关拿它换成你推送的真 key，真 key永远不进沙箱。 */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
const router = new Router(brief);

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/** 网关的 Chat Completions 地址：OPENAI_BASE_URL 可能是 …/v1，也可能不是。 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** 简报里的免费模型，GET /v1/models 就列这些。 */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/**
 * 拨一次网关：POST Chat Completions，model 是点的那个免费模型。
 * 注意这里没有超时：超时是墙钟，正式跑触发、重放不触发，会让重放走另一条路。
 */
async function dial(body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify(body) });
}

/** 网关错误体里的 code（没有就取 type，再没有为空串）。 */
function errorCodeOf(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && isRecord(value.error)) {
      if (typeof value.error.code === 'string' && value.error.code !== '') return value.error.code.slice(0, 64);
      if (typeof value.error.type === 'string') return value.error.type.slice(0, 64);
    }
  } catch {
    // 不是 JSON：没有 code。
  }
  return '';
}

/** 一次真实的网关拒答，进轨迹头的那一行。 */
interface Failure {
  status: number;
  code: string;
  model: string;
}

/** 一道题的 serve 结果：JSON 体，或流式帧；status 非 200 时 json 是错误体。 */
interface Served {
  status: number;
  trail: Failure[];
  json?: Json;
  frames?: string[];
}

/**
 * 答一道题：沿梯队最多试 MAX_ATTEMPTS 个模型。
 * 换模型的两种情况：网关拒答（4xx/5xx，记进轨迹头、记一次冷却），
 * 或答案正文里没有暗号 token（白答，不记拒答、不进轨迹头）。
 * 答出来就按客户端的线翻回去，model 一律写真正拨的那个 id。
 */
async function servePrompt(wire: 'openai' | 'anthropic', body: Json): Promise<Served> {
  const requires = requirementsFromBody(body);
  const token = tokenOfBody(body);
  const requestChars = JSON.stringify(body).length;
  const failures: Failure[] = [];
  const ladder = router.ladder(requires).slice(0, MAX_ATTEMPTS);
  for (const candidate of ladder) {
    const upstreamBody = wire === 'openai' ? openAIToUpstream(body, candidate.id) : anthropicToOpenAI(body, candidate.id);
    let upstream: Response;
    try {
      upstream = await dial(upstreamBody);
    } catch (err) {
      // 网关根本连不上：没有 HTTP 状态可报，不进轨迹头；只记冷却，换下一个。
      router.noteRefusal(candidate.id);
      log(`dial ${candidate.id}: the gateway is unreachable: ${(err as Error).message}`);
      continue;
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      failures.push({ status: upstream.status, code: errorCodeOf(text), model: candidate.id });
      router.noteRefusal(candidate.id);
      log(`dial ${candidate.id}: refused HTTP ${upstream.status}`);
      continue;
    }
    if (upstream.body === null) {
      // 200 却没有 body：当成空答案，暗号校验自然过不了，换下一个。
      log(`dial ${candidate.id}: answered 200 with no body`);
      continue;
    }
    let raw: unknown = null;
    let answer;
    try {
      if (body.stream === true) {
        answer = await collectUpstreamStream(upstream.body);
      } else {
        raw = await upstream.json();
        answer = collectUpstreamJson(isRecord(raw) ? raw : {});
      }
    } catch (err) {
      // 上游 200 但 body 读不出/不是 JSON：当成白答，换下一个。
      log(`dial ${candidate.id}: the answer body is unreadable: ${(err as Error).message}`);
      continue;
    }
    if (token !== null && !answer.text.includes(token)) {
      log(`dial ${candidate.id}: the answer carries no token; failing over`);
      continue;
    }
    if (wire === 'openai') {
      if (body.stream === true) {
        return { status: 200, trail: failures, frames: openAIStreamFrames(answer, candidate.id, requestChars) };
      }
      return { status: 200, trail: failures, json: openAIJsonFromUpstream(isRecord(raw) ? raw : {}, candidate.id) };
    }
    if (body.stream === true) {
      return { status: 200, trail: failures, frames: anthropicStreamEvents(answer, candidate.id, requestChars) };
    }
    return { status: 200, trail: failures, json: openAIToAnthropic(answer, candidate.id, requestChars) };
  }
  // 梯队试完了都没答出来：认 502，trial 继续走下一题。
  const message = `no free model served this prompt${failures.length > 0 ? ` (last refusal HTTP ${failures[failures.length - 1].status})` : ''}`;
  if (wire === 'anthropic') {
    return { status: 502, trail: failures, json: anthropicError('api_error', message) };
  }
  return { status: 502, trail: failures, json: openAIError(message, 'upstream_error', null) };
}

/** 一条客户端请求正文；不是一个 JSON 对象、或超大时返回 null。 */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function trailHeaders(trail: Failure[]): Record<string, string> {
  if (trail.length === 0) return {};
  return { [FAILURES_HEADER]: JSON.stringify(trail.slice(0, 8)) };
}

function sendJson(res: ServerResponse, status: number, body: unknown, trail: Failure[] = []): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...trailHeaders(trail) });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** 一道题的 serve 结果写回客户端：流式写帧，JSON 写体，轨迹头一定带上。 */
function sendServed(res: ServerResponse, served: Served): void {
  if (served.frames !== undefined) {
    res.writeHead(served.status, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...trailHeaders(served.trail),
    });
    for (const frame of served.frames) res.write(frame);
    res.end();
    return;
  }
  sendJson(res, served.status, served.json ?? {}, served.trail);
}

/** GET /v1/models：按来信的认证头选形状——x-api-key 是 Anthropic，其余是 OpenAI。 */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readJson(req);
    if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
    sendServed(res, await servePrompt('openai', body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    const body = await readJson(req);
    if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
    sendServed(res, await servePrompt('anthropic', body));
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register：端口与目录文档；失败立即重发（注册不进评分状态）。 */
async function register(port: number, report: CatalogReport): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < REGISTER_RETRIES; attempt++) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const reply: unknown = await res.json();
      if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
      return;
    } catch (err) {
      lastError = err;
      log(`register attempt ${attempt + 1} failed: ${(err as Error).message}`);
    }
  }
  throw lastError;
}

/** 每 100ms 问一次 GET /work；说 done 就关服务、exit 0。 */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // env 还没起来：下一轮再问。
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // --list 打印的与注册体里的是同一份文档：直接打印建好的那一个对象。
    // 试跑外没有简报可读时，目录是空的——这是规则写明的行为。
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
      }
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 是 env 在一种布局里占的端口；系统分的临时端口不会是它，防一手。
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
