// lib/router.ts —— 路由：给每道题排一条候选梯队，并记录各模型的拒答次数。
//
// 梯队怎么排（运行时从简报现算，不写死模型名）：
//   1. 先筛：只留满足这道题能力要求（tools / vision / json / 上下文）的免费模型；
//   2. 再排：按 rating_milli 从高到低，同分按 id 字典序——
//      分数就是质量分，排在前面的模型答出来分最高；
//   3. 彩票规则：评分最高的那一位如果恰好是推理模型 Inkling，挪到队尾。
//      试跑每题只给 350–502 个输出 token，推理模型容易把预算烧在推理过程里、
//      截断时还没吐出暗号，实战里它从没在正式试跑交出过带暗号的答案；
//      放队尾当彩票：前面全拒了才试它一次，中了是 bonus，不中也不亏。
//   4. 冷却：一个模型在本场试跑里被网关拒答两次后，本场剩余题目不再点它。
//      按拒答次数冷却，不按时间——重放时时间线不同，时间冷却会让重放走另
//      一条路直接判失败；次数只取决于网关的回答，重放时完全一致。
//      注意：答案里没暗号不算拒答（模型好好答了，只是答错了），不计入冷却；
//      同一道题里刚拒答的模型，下一位直接顶上，不用等。
//
// 梯队里是全部 14 个模型（按能力筛完后剩下的）：主力 Super VL（1303）与
// Ultra（1285）打头，Lightning（1221）、Gemma 31B（1210）、North Mini（1200）
// 与 8 个 1150 档全部在链上，Inkling（1475）殿后。JSON 题的梯队只有支持 JSON
// 的 9 个（Super VL、Gemma 31B 与 7 个 1150 档的 JSON 模型）。

import { capabilitiesOf, freeModels, meetsRequirements, type Brief, type Json, type ModelRow, type Requirement } from './brief.ts';

/** 彩票位模型：评分表里唯一一个推理模型，正式试跑里从未交出过带暗号的答案。 */
export const LOTTERY_MODEL_ID = 'openrouter/thinkingmachines/inkling-2-small:free';
/** 一个模型被拒答几次后，本场剩余题目不再点它。 */
export const COOL_AFTER_REFUSALS = 2;
/** 每道题最多试几个模型：再多也只是烧调用次数（平分时调用数越少越好）。 */
export const MAX_ATTEMPTS = 3;

export class Router {
  /** 各模型在本场试跑里被网关拒答的次数（只记 HTTP 4xx/5xx 的拒答）。 */
  private refusals = new Map<string, number>();
  private readonly brief: Brief;

  constructor(brief: Brief) {
    this.brief = brief;
  }

  /**
   * 这道题的候选梯队：满足要求的免费模型，按评分从高到低、id 字典序排，
   * 彩票模型挪到队尾，本场已冷却的模型去掉。返回的顺序就是点名的顺序。
   */
  ladder(requires: Requirement): ModelRow[] {
    const candidates = freeModels(this.brief).filter((m) => meetsRequirements(requires, capabilitiesOf(m)));
    candidates.sort((a, b) => b.rating_milli - a.rating_milli || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (candidates.length > 1 && candidates[0].id === LOTTERY_MODEL_ID) {
      const top = candidates.shift() as ModelRow;
      candidates.push(top);
    }
    return candidates.filter((m) => (this.refusals.get(m.id) ?? 0) < COOL_AFTER_REFUSALS);
  }

  /** 记一次网关拒答（HTTP 4xx/5xx）。答案没暗号不走这里。 */
  noteRefusal(modelId: string): void {
    this.refusals.set(modelId, (this.refusals.get(modelId) ?? 0) + 1);
  }
}

/** 一条客户端请求的全部文本：顶层 system + 每条消息的文本内容（按顺序）。 */
export function requestText(body: Json): string {
  const parts: string[] = [];
  if (typeof body.system === 'string') parts.push(body.system);
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (typeof block === 'object' && block !== null && 'text' in block && typeof (block as Json).text === 'string') {
        parts.push((block as Json).text as string);
      }
    }
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) continue;
    const content = (raw as Json).content;
    if (typeof content === 'string') {
      parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Json;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      if (b.type === 'tool_result' && typeof b.content === 'string') parts.push(b.content);
    }
  }
  return parts.join('\n');
}

/**
 * 请求里带的暗号 token，形如 ZEBRA-4721：大写字母 + 横杠 + 四位数字。
 * 每道题的指令里都带一个唯一的 token，答案必须把它原样带回来；
 * token 校验重试就靠它：上游答案里没有这个 token，等于白答。
 * 请求里找不到 token 时返回 null（那就没法校验，直接 serve 第一个成功答案）。
 */
export function tokenOfBody(body: Json): string | null {
  const match = /[A-Z]{2,12}-[0-9]{4}/.exec(requestText(body));
  return match === null ? null : match[0];
}

/** 从一条客户端请求正文读出能力要求：工具、JSON 模式、有没有图片。 */
export function requirementsFromBody(body: Json): Requirement {
  const requires: Requirement = {};
  if (Array.isArray(body.tools) && body.tools.length > 0) requires.tools = true;
  const format = (body as Json).response_format;
  if (typeof format === 'object' && format !== null && ((format as Json).type === 'json_object' || (format as Json).type === 'json_schema')) {
    requires.json = true;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) continue;
    const content = (raw as Json).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Json;
      if (b.type === 'image' || b.type === 'image_url') requires.vision = true;
    }
  }
  return requires;
}
