/** 非流式 LLM 请求、退化重试与用量归因的确定性测试。 */

import assert from "node:assert/strict";
import {
  hasDegenerateRepetition,
  requestChat,
  type ThinkingDegradeInfo,
} from "../src/lib/llm";

const MODEL = "deepseek-v4-flash";
const originalFetch = globalThis.fetch;
const originalApiKey = process.env.LLM_API_KEY;
const originalBackoff = process.env.LLM_BACKOFF_BASE_MS;
const originalSpiral = process.env.REASONING_SPIRAL_CHARS;

process.env.LLM_API_KEY = "test-key";
process.env.LLM_BACKOFF_BASE_MS = "1";
process.env.REASONING_SPIRAL_CHARS = "60";

function messages() {
  return [{ role: "user" as const, content: "测试" }];
}

function completion(
  content: string,
  reasoning = "",
  usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content, reasoning_content: reasoning }, finish_reason: "stop" }],
      usage: {
        ...usage,
        completion_tokens_details: { reasoning_tokens: reasoning ? 3 : 0 },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function installFetch(responses: Array<Response | Error>) {
  const bodies: string[] = [];
  let index = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    const next = responses[index++];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { bodies, calls: () => index };
}

function tearDown() {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = originalApiKey;
  if (originalBackoff === undefined) delete process.env.LLM_BACKOFF_BASE_MS;
  else process.env.LLM_BACKOFF_BASE_MS = originalBackoff;
  if (originalSpiral === undefined) delete process.env.REASONING_SPIRAL_CHARS;
  else process.env.REASONING_SPIRAL_CHARS = originalSpiral;
}

async function main() {
  // 完整结果、推理与 usage 一次返回；请求体明确关闭 stream。
  {
    const { bodies } = installFetch([completion("最终答案", "必要推理")]);
    const result = await requestChat({ model: MODEL, messages: messages() });
    assert.equal(result.content, "最终答案");
    assert.equal(result.reasoning, "必要推理");
    assert.equal(result.usage.totalTokens, 15);
    assert.equal(result.usage.reasoningTokens, 3);
    const body = JSON.parse(bodies[0]);
    assert.equal(body.stream, false);
    assert.equal("stream_options" in body, false);
    console.log("LLM · ✓ 非流式最终结果、推理和 usage");
  }

  // thinking 控制和 JSON 模式仍按原协议透传。
  {
    const { bodies } = installFetch([completion('{"ok":true}')]);
    await requestChat({
      model: MODEL,
      messages: messages(),
      thinking: "disabled",
      jsonMode: true,
    });
    const body = JSON.parse(bodies[0]);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.deepEqual(body.response_format, { type: "json_object" });
    console.log("LLM · ✓ thinking 与 JSON 模式参数");
  }

  // 空正文会计入废弃成本、关闭 thinking 后重试。
  {
    const first = completion("", "x".repeat(80), {
      prompt_tokens: 20,
      completion_tokens: 30,
      total_tokens: 50,
    });
    const { bodies } = installFetch([first, completion("恢复")]);
    let degrade: ThinkingDegradeInfo | undefined;
    const result = await requestChat(
      { model: MODEL, messages: messages() },
      { onThinkingDegrade: (event) => (degrade = event) },
    );
    assert.equal(result.content, "恢复");
    assert.equal(result.usage.totalTokens, 65);
    assert.equal(degrade?.reason, "spiral");
    assert.deepEqual(JSON.parse(bodies[1]).thinking, { type: "disabled" });
    console.log("LLM · ✓ 空正文降级重试与废弃用量累计");
  }

  // 模型重复同一长句时不把垃圾结果交给解析器。
  {
    const sentence = "这是模型发生退化后不断重复的一段无效分析，它没有继续提供新的文件或结论内容，并且仍在无意义地循环";
    const repeated = Array.from({ length: 120 }, () => sentence).join("。") + "。";
    assert.equal(hasDegenerateRepetition(repeated), true);
    const { bodies } = installFetch([completion(repeated), completion("<<<FILE /App.js>>>\nok\n<<<END>>>")]);
    let degrade: ThinkingDegradeInfo | undefined;
    const result = await requestChat(
      { model: MODEL, messages: messages(), thinking: "disabled" },
      { onThinkingDegrade: (event) => (degrade = event) },
    );
    assert.match(result.content, /FILE/);
    assert.equal(degrade, undefined, "本来已关闭 thinking 时无需重复发降级事件");
    assert.match(JSON.parse(bodies[1]).messages[0].content, /重复输出/);
    console.log("LLM · ✓ 重复正文识别并重试");
  }

  // 可恢复网络错误重试，但不改变 thinking 策略。
  {
    const { bodies, calls } = installFetch([new TypeError("fetch failed"), completion("ok")]);
    let retries = 0;
    const result = await requestChat(
      { model: MODEL, messages: messages() },
      { onRetry: () => retries++ },
    );
    assert.equal(result.content, "ok");
    assert.equal(calls(), 2);
    assert.equal(retries, 1);
    assert.equal("thinking" in JSON.parse(bodies[1]), false);
    console.log("LLM · ✓ 网络错误重试保留 thinking 策略");
  }

  // 上游不支持 JSON mode 时降级为普通文本请求。
  {
    const unsupported = new Response("unsupported", { status: 400 });
    const { bodies } = installFetch([unsupported, completion('{"ok":true}')]);
    const result = await requestChat({ model: MODEL, messages: messages(), jsonMode: true });
    assert.equal(result.content, '{"ok":true}');
    assert.equal("response_format" in JSON.parse(bodies[0]), true);
    assert.equal("response_format" in JSON.parse(bodies[1]), false);
    console.log("LLM · ✓ JSON mode 不支持时自动降级");
  }

  tearDown();
  console.log("LLM 非流式单测 · 全部通过");
}

main().catch((error) => {
  tearDown();
  console.error(error);
  process.exit(1);
});
