// lib/brief.ts —— 试跑简报的读取与目录文档的生成。
//
// 简报（$MAKEFUN_PROMPT_FILE）是一段纯文本，里面嵌着两份 JSON 文档：
//   - 免费模型清单（schema 为 free-model-aggregator-02/models/v1）：每个免费模型
//     的网关 id、评分 rating_milli、能力（tools / vision / json）与上下文长度；
//   - 六道题的清单（schema 为 free-model-aggregator-02/prompts/v1）：每道题的
//     id、走哪条线、是否流式、权重与能力要求。
// 本文件只做解析与目录生成，不做任何网络调用、不读墙钟、不做随机选择，
// 所以 --list 打印的文档与 /register 注册体里的文档永远是同一份、字节一致。

import { readFileSync } from 'node:fs';

/** 简报里两份文档的 schema 前缀：找文档只认这个前缀，不认名字。 */
const SCHEMA_PREFIX = 'free-model-aggregator-02/';
/** 免费模型所属的公开端点：目录里写这个，绝不写试跑网关的临时地址。 */
export const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
/** 推送 OpenRouter key 时用的环境变量名。 */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 简报里的一行免费模型。id 是网关路由用的 id（带 openrouter/ 前缀）。 */
export interface ModelRow {
  id: string;
  provider: string;
  display_name: string;
  /** 评分，单位 milli：质量分就按这个算，越高越好。 */
  rating_milli: number;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  free: boolean;
}

/** 一道题对模型的能力要求：缺了其中任何一项的模型不能上。 */
export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

/** 简报里的一道题（只保留路由用得上的字段）。 */
export interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requirement;
}

/** 解析后的简报。error 非空表示某份文档没读出来。 */
export interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
  error: string | null;
}

/** 目录文档里的一行模型。 */
export interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

/** 目录文档里的一个供应商。 */
export interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: 'openai';
  models: CatalogModel[];
}

/** --list 打印、/register 注册的同一份目录文档。 */
export interface CatalogReport {
  providers: CatalogProvider[];
}

/** 文本里所有带 string 类型 schema 字段的 JSON 对象，按出现顺序。 */
function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // 不是独立的 JSON 对象：继续往后找。
    }
  }
  return out;
}

/** 从 start 处开括号起、配对闭括号的位置；字符串内容跳过；找不到返回 -1。 */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stringOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** 本比赛前缀下、第一个带有 keys 中任意一个数组字段的文档。 */
function arrayDocument(docs: readonly Json[], keys: readonly string[]): { doc: Json; key: string } | null {
  for (const doc of docs) {
    if (!stringOf(doc.schema).includes(SCHEMA_PREFIX)) continue;
    for (const key of keys) if (Array.isArray(doc[key])) return { doc, key };
  }
  return null;
}

/** 一行模型。id 缺省时用 model 字段；裸 id（不带 openrouter/ 前缀）自动补上。 */
function modelOf(v: unknown): ModelRow | null {
  if (!isRecord(v)) return null;
  const raw = stringOf(v.id) !== '' ? stringOf(v.id) : stringOf(v.model);
  if (raw === '') return null;
  const named = stringOf(v.provider) !== '' ? stringOf(v.provider) : stringOf(v.wire);
  const id = named === 'openrouter' && !raw.toLowerCase().startsWith('openrouter/') ? `openrouter/${raw}` : raw;
  return {
    id,
    provider: named === '' ? 'openrouter' : named,
    display_name: stringOf(v.display_name) !== '' ? stringOf(v.display_name) : raw,
    rating_milli: numberOrNull(v.rating_milli) ?? 0,
    context_length: numberOrNull(v.context_length),
    tools: boolOrNull(v.tools),
    vision: boolOrNull(v.vision),
    json: boolOrNull(v.json),
    // 简报列的是免费模型：没写 free: false 的都算免费。
    free: v.free !== false,
  };
}

/** 一道题。 */
function promptOf(v: unknown): PromptRow | null {
  if (!isRecord(v)) return null;
  const id = stringOf(v.id);
  if (id === '') return null;
  const requires = isRecord(v.requires) ? v.requires : {};
  return {
    id,
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    requires: {
      ...(requires.tools === true ? { tools: true } : {}),
      ...(requires.vision === true ? { vision: true } : {}),
      ...(requires.json === true ? { json: true } : {}),
      ...(typeof requires.min_context === 'number' && Number.isFinite(requires.min_context)
        ? { min_context: requires.min_context }
        : {}),
    },
  };
}

/** 读 path 处的简报，找出模型清单与题目清单。 */
export function readBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { models: [], prompts: [], error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = documentsIn(text);
  const modelsDoc = arrayDocument(docs, ['models', 'ratings']);
  if (modelsDoc === null) {
    return { models: [], prompts: [], error: `the brief at ${path} holds no free-model-aggregator-02/models/v1 document` };
  }
  const models = (modelsDoc.doc[modelsDoc.key] as unknown[]).flatMap((v) => {
    const m = modelOf(v);
    return m === null ? [] : [m];
  });
  const promptsDoc = arrayDocument(docs, ['prompts', 'manifest']);
  if (promptsDoc === null) {
    return { models, prompts: [], error: `the brief at ${path} holds no free-model-aggregator-02/prompts/v1 document` };
  }
  const prompts = (promptsDoc.doc[promptsDoc.key] as unknown[]).flatMap((v) => {
    const p = promptOf(v);
    return p === null ? [] : [p];
  });
  return { models, prompts, error: null };
}

/** 简报里列的免费模型，按简报顺序。 */
export function freeModels(brief: Brief): ModelRow[] {
  return brief.models.filter((m) => m.free);
}

/** 一个模型的能力快照（null 表示简报没写）。 */
export function capabilitiesOf(model: ModelRow): { context_length: number | null; tools: boolean | null; vision: boolean | null; json: boolean | null } {
  return { context_length: model.context_length, tools: model.tools, vision: model.vision, json: model.json };
}

/** 模型能力是否满足一道题的要求：能力未知（null）算不满足。 */
export function meetsRequirements(
  requires: Requirement,
  caps: { context_length: number | null; tools: boolean | null; vision: boolean | null; json: boolean | null },
): boolean {
  if (requires.tools === true && caps.tools !== true) return false;
  if (requires.vision === true && caps.vision !== true) return false;
  if (requires.json === true && caps.json !== true) return false;
  if (requires.min_context !== undefined && (caps.context_length === null || caps.context_length < requires.min_context)) return false;
  return true;
}

/**
 * 由简报的免费模型清单生成目录文档：一个供应商 openrouter，模型恰好是
 * 简报列的免费模型（去重、按简报顺序）。目录分只比 id 集合：多一个、少一个、
 * 重一个都丢这 5 分，所以这里一个字都不能多、一个都不能少。
 * 简报为空时返回空供应商列表（试跑外跑 --list 时的行为）。
 */
export function buildCatalog(brief: Brief): CatalogReport {
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const model of brief.models) {
    if (!model.free || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({ id: model.id, free: true, context_length: model.context_length });
  }
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: OPENROUTER_PUBLIC_BASE,
        key_env: OPENROUTER_KEY_ENV,
        wire: 'openai',
        models,
      },
    ],
  };
}
