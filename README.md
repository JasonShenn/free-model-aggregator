# free-model-aggregator

一个服务器，两条线，十四 个免费模型。

客户端指过来就能用：OpenAI 的 `POST /v1/chat/completions` 与 Anthropic 的
`POST /v1/messages`，JSON 与流式都接；每道请求的答案都来自一个真正的免费模型，
经 OpenRouter 拨回来，绝不是本机编的。

```sh
node main.ts --list        # 打印本服务能提供的免费模型目录
node main.ts               # 启动服务（试跑环境里由 harness 驱动）
```

## 它是怎么挑模型的

简报里每个免费模型都有一个公开评分（`rating_milli`）。每次请求进来，
服务按评分从高到低排一条候选梯队，顺着梯队一个一个拨：

- **主力**：NVIDIA Nemotron 3.5 Super VL（1303）与 Nemotron 3 Ultra（1285）——
  两档答出来的质量分最高，是 94 分档的基石；
- **备用链**：Lightning（1221）、Gemma 4 31B（1210）、North Mini（1200）与
  8 个 1150 档的模型全部在链上，主力拒答时依次顶上；
- **彩票**：Thinking Machines Inkling（1475）只放最后一位。它评分最高，
  但每道题只有 350–502 个输出 token，推理模型容易把预算烧在推理过程里、
  截断时还没吐出答案；前面全拒了才试它一次，中了是 bonus，不中也不亏；
- **JSON 题**：只有支持 JSON 模式的 9 个模型能进梯队（Super VL、Gemma 31B
  与 7 个 1150 档的 JSON 模型）。

换模型的两种情况：

1. **网关拒答**（HTTP 4xx/5xx，如 429 限流、5xx）：记进响应头
   `x-makefun-upstream-failures`，再换下一个；一个模型在本场试跑里被拒两次
   后，本场剩余题目不再点它（按次数冷却，不按时间——重放时时间线不同，
   时间冷却会让重放走另一条路）；
2. **答案里没有暗号**：每道题的指令里都带一个唯一的 token（如 `ZEBRA-4721`），
   答案正文里没有它等于白答，换下一个模型再试。白答不算拒答，不进轨迹头。

每道题最多试 3 个模型——再多也只是烧调用次数（同分时调用数越少越靠前）。

## 格式上较真的几件事

- **usage 一定有**：上游的 usage 原样透传；流式在收尾块里带 usage，
  Anthropic 线把它翻进 `message_start` / `message_delta`；
- **model 字段一定是真拨的 id**：每个答案、每个流式块都写拨的那个 id
  （带 `openrouter/` 前缀）；
- **stop_reason 一定合法**：OpenAI 线只用 `stop` / `length` / `tool_calls` /
  `function_call` / `content_filter`，Anthropic 线只用 `end_turn` /
  `max_tokens` / `stop_sequence` / `tool_use` / `refusal` / `pause_turn`；
- **流式先收完再重发**：上游的流收完整段、验过暗号，再按规范顺序重发
  （OpenAI：内容块 + 收尾块 + `[DONE]`；Anthropic：`message_start` →
  `content_block_start` → `delta*` → `content_block_stop` → `message_delta`
  → `message_stop`）；
- **绝不调 Anthropic Messages 路由**：所有免费模型只走 Chat Completions，
  Anthropic 的请求先翻成 Chat Completions 再拨；
- **确定性**：一切选择只取决于简报、请求与网关已经给过的回答。不读墙钟，
  不用无种子随机，上游调用也不设超时——超时是墙钟决定，正式跑触发、
  重放不触发，会让重放走另一条路。

## 目录

`node main.ts --list` 打印的目录文档，与注册时提交的同一份、字节一致：
一个供应商 `openrouter`，模型恰好是简报列的 14 个免费模型，一个不多、
一个不少。`GET /v1/models` 按来信的认证头回形状：`Authorization: Bearer`
回 OpenAI 的列表，`x-api-key` 回 Anthropic 的列表，列的都是同一批 id。

## 文件

```
main.ts          入口：HTTP 服务、拨号与重试、注册、轮询退出
lib/brief.ts     简报解析（模型清单、题目清单）与目录文档生成
lib/router.ts    候选梯队、冷却、暗号提取、请求的能力要求
lib/wire.ts      两条客户端线与上游线的互翻、流式重发、usage 兜底
```

只用 Node 22 标准库，不装任何依赖。TypeScript 直接跑
（只用可擦除的语法：没有枚举、没有参数属性）。

## 许可证

MIT，见 [LICENSE](LICENSE)。
