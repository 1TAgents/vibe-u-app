/**
 * 推理空转护栏的确定性测试 —— 可控 mocked fetch,不碰真实 LLM。
 *
 * 覆盖三条行为契约:
 *   1. 思考超过阈值且正文为零 → 掐流 → 重试 → 成功,且废弃尝试的耗用累加进最终 usage
 *   2. 三次都空转 → 明确失败,且失败携带废弃耗用(err.usage),成本面板不丢
 *   3. 退避/重试期间尊重 AbortSignal:取消不用等完整个退避窗口
 */

import assert from "node:assert/strict";
import { streamChat, type ThinkingDegradeInfo } from "../src/lib/llm";

const MODEL = "deepseek-v4-flash";
const SPIRAL_CHARS = 60; // 思考字符数 > 阈值,触发螺旋

const originalFetch = globalThis.fetch;
const originalSpiral = process.env.REASONING_SPIRAL_CHARS;
const originalBackoff = process.env.LLM_BACKOFF_BASE_MS;

/* ------------------------------ SSE 帧构造 ------------------------------ */

const enc = new TextEncoder();

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
function reasoningFrame(text: string): string {
  return sseFrame({ choices: [{ delta: { reasoning_content: text } }] });
}
function contentFrame(text: string): string {
  return sseFrame({ choices: [{ delta: { content: text } }] });
}
function usageFrame(p: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens: number;
}): string {
  return sseFrame({
    usage: {
      prompt_tokens: p.prompt_tokens,
      completion_tokens: p.completion_tokens,
      total_tokens: p.total_tokens,
      completion_tokens_details: { reasoning_tokens: p.reasoning_tokens },
    },
  });
}

function streamResponse(frames: string[]): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= frames.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(frames[i++]));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** 一条只吐思考、永不吐正文的流 —— 空转典型样本 */
function spiralStream(): Response {
  return streamResponse([reasoningFrame("x".repeat(SPIRAL_CHARS))]);
}

/** 一条流正常结束、但正文为空、思考也很小的流 —— 低 token 空响应典型样本 */
const EMPTY_REASON = "brief";
function emptyStream(): Response {
  return streamResponse([reasoningFrame(EMPTY_REASON)]);
}

function installFetch(
  responses: Response[],
): { calls: { count: number }; bodies: string[] } {
  const calls = { count: 0 };
  const bodies: string[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    const r = responses[calls.count++];
    assert.ok(r, "fetch 被调用的次数超出了提供的响应");
    return r;
  }) as typeof fetch;
  return { calls, bodies };
}

/* ------------------------------ 测试 ------------------------------ */

const sys = "系统指令";
const user = "写一个代码";
const promptEstimate = Math.ceil((sys.length + user.length) / 3);

function messages() {
  return [
    { role: "system" as const, content: sys },
    { role: "user" as const, content: user },
  ];
}

function tearDown() {
  globalThis.fetch = originalFetch;
  if (originalSpiral === undefined) delete process.env.REASONING_SPIRAL_CHARS;
  else process.env.REASONING_SPIRAL_CHARS = originalSpiral;
  if (originalBackoff === undefined) delete process.env.LLM_BACKOFF_BASE_MS;
  else process.env.LLM_BACKOFF_BASE_MS = originalBackoff;
}

(async () => {
  process.env.REASONING_SPIRAL_CHARS = "50";
  process.env.LLM_BACKOFF_BASE_MS = "1";

  // ---- 1. 螺旋 → 重试 → 成功,废弃耗用累加进最终 usage ----
  {
    const { bodies } = installFetch([
      spiralStream(),
      streamResponse([
        reasoningFrame("思考一下"),
        contentFrame("done"),
        usageFrame({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, reasoning_tokens: 40 }),
      ]),
    ]);
    let retries = 0;
    const result = await streamChat(
      { model: MODEL, messages: messages(), maxTokens: 16000 },
      { onRetry: () => retries++ },
    );

    assert.equal(result.content, "done");
    assert.equal(retries, 1, "螺旋一次应恰好重试一次");
    const wastedCompletion = Math.ceil(SPIRAL_CHARS / 3);
    assert.equal(result.usage.promptTokens, 100 + promptEstimate, "prompt 每个尝试各算一次");
    assert.equal(result.usage.completionTokens, 50 + wastedCompletion, "废弃尝试的完成 token 计入");
    assert.equal(result.usage.reasoningTokens, 40 + wastedCompletion, "废弃尝试的思考 token 计入");
    assert.equal(result.usage.totalTokens, 150 + promptEstimate + wastedCompletion);
    assert.match(bodies[1], /思考循环/, "螺旋重试的请求应携带打断思考的提示");
    console.log(`LLM · ✓ 螺旋后成功:废弃 ${promptEstimate}+${wastedCompletion} tok 计入最终 usage (retries=${retries})`);
  }

  // ---- 2. 三次都空转 → 明确失败,失败携带废弃耗用 ----
  {
    const calls = installFetch([spiralStream(), spiralStream(), spiralStream()]);
    let err: Error & { usage?: { totalTokens: number; costUsd: number } } | undefined;
    try {
      await streamChat({ model: MODEL, messages: messages(), maxTokens: 16000 });
    } catch (e) {
      err = e as typeof err;
    }
    assert.ok(err, "三次空转必须失败");
    assert.match(err.message, /推理空转/);
    assert.match(err.message, /3 次/);
    assert.equal(calls.calls.count, 3, "应恰好发起 3 次请求");
    const wastedCompletion = Math.ceil(SPIRAL_CHARS / 3);
    assert.equal(err.usage?.totalTokens, 3 * (promptEstimate + wastedCompletion), "废弃耗用通过错误携带");
    assert.ok((err.usage?.costUsd ?? 0) > 0, "成本估算非零");
    console.log(`LLM · ✓ 三次空转明确失败,err.usage.totalTokens=${err.usage?.totalTokens}`);
  }

  // ---- 3. 退避期间尊重 AbortSignal ----
  {
    // 退避基数调大,让取消能在窗口内打断;若不尊重信号,要等满整个退避窗口
    process.env.LLM_BACKOFF_BASE_MS = "800";
    const calls = installFetch([spiralStream()]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("user-cancelled")), 20);
    const t0 = Date.now();
    let errMsg: string | undefined;
    try {
      await streamChat(
        { model: MODEL, messages: messages(), maxTokens: 16000, signal: ac.signal },
        { onRetry: () => {} },
      );
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    }
    const elapsed = Date.now() - t0;
    assert.equal(errMsg, "user-cancelled");
    assert.equal(calls.calls.count, 1, "取消后不应再发新请求");
    assert.ok(elapsed < 500, `退避应被取消打断,实际 ${elapsed}ms`);
    console.log(`LLM · ✓ 退避期间取消即时生效(${elapsed}ms)`);
  }

  // ---- 4. 流正常结束但正文为空(低 token 空响应)→ 视为退化,重试 → 成功 ----
  {
    process.env.LLM_BACKOFF_BASE_MS = "1";
    const { bodies } = installFetch([
      emptyStream(),
      streamResponse([
        reasoningFrame("思考一下"),
        contentFrame("done"),
        usageFrame({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, reasoning_tokens: 40 }),
      ]),
    ]);
    let retries = 0;
    const result = await streamChat(
      { model: MODEL, messages: messages(), maxTokens: 16000 },
      { onRetry: () => retries++ },
    );

    assert.equal(result.content, "done");
    assert.equal(retries, 1, "短空响应应重试一次");
    const wastedCompletion = Math.ceil(EMPTY_REASON.length / 3);
    assert.equal(result.usage.promptTokens, 100 + promptEstimate, "废弃尝试的 prompt 计入");
    assert.equal(result.usage.completionTokens, 50 + wastedCompletion);
    assert.equal(result.usage.reasoningTokens, 40 + wastedCompletion);
    assert.equal(result.usage.totalTokens, 150 + promptEstimate + wastedCompletion);
    assert.match(bodies[1], /空内容/, "空响应重试的请求应携带不要留空的提示");
    console.log(`LLM · ✓ 短空响应→重试→成功,废弃 ${promptEstimate}+${wastedCompletion} tok 计入`);
  }

  // ---- 5. 三次短空响应 → 明确失败,不误称「预算耗尽」 ----
  {
    const calls = installFetch([emptyStream(), emptyStream(), emptyStream()]);
    let err: Error & { usage?: { totalTokens: number; costUsd: number } } | undefined;
    try {
      await streamChat({ model: MODEL, messages: messages(), maxTokens: 16000 });
    } catch (e) {
      err = e as typeof err;
    }
    assert.ok(err, "三次空响应必须失败");
    assert.match(err.message, /空响应/);
    assert.match(err.message, /3 次/);
    assert.doesNotMatch(err.message, /预算被思考耗尽/, "低 token 空正文不得误称预算耗尽");
    assert.equal(calls.calls.count, 3);
    const wastedCompletion = Math.ceil(EMPTY_REASON.length / 3);
    assert.equal(err.usage?.totalTokens, 3 * (promptEstimate + wastedCompletion), "废弃耗用通过错误携带");
    assert.ok((err.usage?.costUsd ?? 0) > 0);
    console.log(`LLM · ✓ 三次短空响应明确失败(err.usage.totalTokens=${err.usage?.totalTokens})`);
  }

  // ---- 6. 进入退避前 signal 已 aborted → 立即拒绝,不等待、不重试 ----
  {
    const ac = new AbortController();
    ac.abort(new Error("cancelled-early"));
    const calls = installFetch([emptyStream()]);
    const t0 = Date.now();
    let errMsg: string | undefined;
    try {
      await streamChat(
        { model: MODEL, messages: messages(), maxTokens: 16000, signal: ac.signal },
        { onRetry: () => {} },
      );
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    }
    const elapsed = Date.now() - t0;
    assert.equal(errMsg, "cancelled-early");
    assert.equal(calls.calls.count, 1, "已取消的信号不应触发重试");
    assert.ok(elapsed < 300, `已取消应立即拒绝,实际 ${elapsed}ms`);
    console.log(`LLM · ✓ 已 aborted 信号立即拒绝(${elapsed}ms)`);
  }

  // ---- 7. thinking 控制写入请求体:disabled 显式禁用;默认不带该字段 ----
  {
    const ok = () =>
      streamResponse([
        reasoningFrame("思考一下"),
        contentFrame("done"),
        usageFrame({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, reasoning_tokens: 4 }),
      ]);
    const { bodies } = installFetch([ok()]);
    await streamChat({ model: MODEL, messages: messages(), maxTokens: 16000, thinking: "disabled" });
    assert.ok(bodies[0].includes('"thinking":{"type":"disabled"}'), "thinking:disabled 应写入请求体");
    assert.match(bodies[0], /"thinking":\{"type":"disabled"\}/, "请求体应为 thinking:{type:disabled} 结构");
    console.log("LLM · ✓ thinking:\"disabled\" 写入请求体(DeepSeek V4 关闭思考)");
  }
  {
    const ok = () =>
      streamResponse([
        reasoningFrame("思考一下"),
        contentFrame("done"),
        usageFrame({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, reasoning_tokens: 4 }),
      ]);
    const { bodies } = installFetch([ok()]);
    await streamChat({ model: MODEL, messages: messages(), maxTokens: 16000 });
    assert.ok(!bodies[0].includes('"thinking"'), "默认请求体不应带 thinking 字段(网关默认 enabled)");
    console.log("LLM · ✓ 默认不传 thinking 时请求体不带该字段");
  }

  // ---- 8. 推理空转 → 下一次重试 thinking=disabled,并恢复正文 ----
  {
    const { bodies } = installFetch([
      spiralStream(),
      streamResponse([
        reasoningFrame("思考一下"),
        contentFrame("done"),
        usageFrame({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, reasoning_tokens: 40 }),
      ]),
    ]);
    let degrade: ThinkingDegradeInfo | undefined;
    const result = await streamChat(
      { model: MODEL, messages: messages(), maxTokens: 16000 },
      { onThinkingDegrade: (info) => (degrade = info) },
    );
    assert.equal(result.content, "done", "降级后必须能恢复正文");
    assert.ok(degrade, "空转后必须触发推理模式降级");
    assert.equal(degrade.reason, "spiral", "降级原因应为 spiral");
    assert.equal(degrade.from, "default", "降级前为默认 thinking");
    assert.equal(degrade.to, "disabled", "降级后为 disabled");
    assert.equal(degrade.attempt, 2, "第 2 次尝试关闭 thinking");
    assert.ok(degrade.wastedTokens > 0, "废弃耗用应随降级事件记录");
    assert.ok(!bodies[0].includes('"thinking"'), "第一次请求保持默认(未降级)");
    assert.ok(bodies[1].includes('"thinking":{"type":"disabled"}'), "第二次请求必须 thinking:disabled");
    assert.match(bodies[1], /思考循环/, "推力提示仍随重试发送");
    console.log(`LLM · ✓ 空转后下一次重试关闭 thinking 并恢复正文(废弃 ${degrade.wastedTokens} tok)`);
  }

  // ---- 9. 短空响应(低 token 空正文)→ 下一次重试 thinking=disabled ----
  {
    const { bodies } = installFetch([
      emptyStream(),
      streamResponse([
        reasoningFrame("思考一下"),
        contentFrame("done"),
        usageFrame({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, reasoning_tokens: 40 }),
      ]),
    ]);
    let degrade: ThinkingDegradeInfo | undefined;
    const result = await streamChat(
      { model: MODEL, messages: messages(), maxTokens: 16000 },
      { onThinkingDegrade: (info) => (degrade = info) },
    );
    assert.equal(result.content, "done");
    assert.equal(degrade?.reason, "empty", "短空响应的降级原因应为 empty");
    assert.equal(degrade?.to, "disabled");
    assert.ok(bodies[1].includes('"thinking":{"type":"disabled"}'), "空响应重试必须 thinking:disabled");
    console.log("LLM · ✓ 短空响应后下一次重试关闭 thinking");
  }

  // ---- 10. 普通网络错误重试保留原策略(thinking 不变、不触发降级) ----
  {
    const ok = () =>
      streamResponse([
        reasoningFrame("思考一下"),
        contentFrame("done"),
        usageFrame({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, reasoning_tokens: 4 }),
      ]);
    const bodies: string[] = [];
    let calls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls++;
      bodies.push(typeof init?.body === "string" ? init.body : "");
      if (calls === 1) throw new TypeError("fetch failed"); // 网络层抛错
      return ok();
    }) as typeof fetch;
    let degrades = 0;
    const result = await streamChat(
      { model: MODEL, messages: messages(), maxTokens: 16000 },
      { onThinkingDegrade: () => degrades++ },
    );
    assert.equal(result.content, "done");
    assert.equal(calls, 2, "网络错误应重试一次");
    assert.equal(degrades, 0, "普通网络错误不得触发推理模式降级");
    assert.ok(!bodies[0].includes('"thinking"'));
    assert.ok(!bodies[1].includes('"thinking"'), "网络错误重试必须保留原 thinking 策略");
    globalThis.fetch = orig;
    console.log("LLM · ✓ 普通网络错误重试保留原 thinking(不降级)");
  }

  // ---- 11. 防止无限空转:关闭 thinking 后仍空转不会反复降级,3 次上限内终止 ----
  {
    const calls = installFetch([spiralStream(), spiralStream(), spiralStream()]);
    let degrades = 0;
    let err: Error | undefined;
    try {
      await streamChat(
        { model: MODEL, messages: messages(), maxTokens: 16000 },
        { onThinkingDegrade: () => degrades++ },
      );
    } catch (e) {
      err = e instanceof Error ? e : undefined;
    }
    assert.ok(err, "持续空转必须失败");
    assert.equal(calls.calls.count, 3, "必须被 3 次尝试上限截住");
    assert.equal(degrades, 1, "降级只发生一次(第 2 次起已是 disabled),不会无限降级");
    assert.ok(calls.bodies[1].includes('"thinking":{"type":"disabled"}'), "第 2 次已关闭 thinking");
    assert.ok(calls.bodies[2].includes('"thinking":{"type":"disabled"}'), "第 3 次保持 disabled");
    console.log("LLM · ✓ 关闭 thinking 后仍空转,降级只一次、3 次上限内终止");
  }

  tearDown();
  console.log("LLM 护栏单测 · 全部通过");
})().catch((e) => {
  tearDown();
  console.error(e);
  process.exit(1);
});
