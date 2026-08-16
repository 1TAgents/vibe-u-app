/**
 * 角色调用设施 —— 把一次 LLM 调用变成一份「经过 schema 校验的产物」。
 *
 * 两件事在这里做,别处不做:
 *   逐 token 转发到事件流 —— 思考链、原始输出、用量都留痕
 *   解析失败把错误原文回喂让它重写 —— 而且**每次打回都发事件**,
 *     悄悄重试等于把失败藏起来,审计时看不到「谁被修正了几次、因为什么」
 *
 * 这一层不含任何判定。产出合不合格由门说了算。
 */

import { extractJson, streamChat } from "./llm";
import { EventSink } from "./sink";
import { ROLES } from "./roles";
import type { NodeId } from "./events";

export { extractJson };

/** 解析打回的次数 —— 属于「一次干活内部」的局部预算,不占派单轮次 */
const MAX_PARSE_RETRIES = 2;

interface AgentCallOptions {
  node: NodeId;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  /**
   * 是否开启网关的 JSON 模式。
   * 写散文的角色(PM / 架构师)产出 JSON,开着能压掉围栏和解释文字;
   * 写代码的角色产出的是文件块格式,开着会把源码硬塞回 JSON 里,必须关掉。
   */
  jsonMode?: boolean;
  /**
   * 推理模式控制(DeepSeek V4 thinking 默认 enabled)。
   * 代码直出角色(Alex 的 engineer/fix/iterate)显式 "disabled" —— 长代码输出
   * 不该先把思考预算烧光;Emma/Maya/Bob/Vera/triage 不传,保持默认 enabled。
   */
  thinking?: "enabled" | "disabled";
}

/**
 * 调用一个角色并把全过程摊开成事件。
 * 关键点:`prompt` 和 `raw` 原样进事件流 —— 用户可以在 UI 上展开看到
 * 我们究竟发了什么、模型究竟回了什么。不可审计的 agent 等于黑盒。
 */
async function callAgent(
  sink: EventSink,
  opts: AgentCallOptions & { messages?: { role: "system" | "user" | "assistant"; content: string }[] },
  signal?: AbortSignal,
): Promise<string> {
  const role = ROLES[opts.node] ?? { name: opts.node, title: opts.node };
  sink.emit({
    type: "node.started",
    node: opts.node,
    role: `${role.name} · ${role.title}`,
    model: opts.model,
  });

  const messages = opts.messages ?? [
    { role: "system" as const, content: opts.system },
    { role: "user" as const, content: opts.user },
  ];

  try {
    const result = await streamChat(
      {
        model: opts.model,
        messages,
        maxTokens: opts.maxTokens,
        // 默认**关**。忘记设置时的后果必须是可恢复的:
        // 不强制 JSON 只损失一点解析便利,而强制 JSON 会让输出文件块的角色
        // 彻底写不出东西 —— 实测里 Cody 因此连废三轮,而失败信息只显示
        // 「没找到文件块」,看不出是被格式约束掐死的。
        jsonMode: opts.jsonMode ?? false,
        signal,
        ...(opts.thinking ? { thinking: opts.thinking } : {}),
      },
      {
        onReasoning: (text) =>
          sink.emit({ type: "node.reasoning.delta", node: opts.node, text }),
        onContent: (text) =>
          sink.emit({ type: "node.content.delta", node: opts.node, text }),
        onRetry: (attempt, waitMs) =>
          sink.emit({ type: "node.retry", node: opts.node, attempt, waitMs }),
        onThinkingDegrade: (info) =>
          sink.emit({
            type: "node.thinking_degrade",
            node: opts.node,
            attempt: info.attempt,
            reason: info.reason,
            from: info.from,
            to: info.to,
            ...(info.wastedTokens !== undefined ? { wastedTokens: info.wastedTokens } : {}),
            ...(info.wastedCostUsd !== undefined ? { wastedCostUsd: info.wastedCostUsd } : {}),
          }),
      },
    );

    sink.emit({
      type: "node.finished",
      node: opts.node,
      usage: result.usage,
      durationMs: result.durationMs,
      prompt: messages.map((m) => `【${m.role}】\n${m.content}`).join("\n\n"),
      raw: result.content,
    });
    return result.content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 失败也可能带着已消费的 token/成本(推理空转被掐断的尝试),
    // 通过事件保留,fold 会算进 totals,成本面板不丢耗用
    const usage = (err as { usage?: import("./events").Usage } | undefined)?.usage;
    sink.emit({ type: "node.failed", node: opts.node, error: msg, ...(usage ? { usage } : {}) });
    throw err;
  }
}

/**
 * 调用角色并把产物解析成受 schema 约束的对象;解析失败则把错误回喂给模型自我修正。
 *
 * 这是必需的而不是保险丝:实测 glm-5.2 会偶发写出
 * `"components": "a", "b"]`(漏了左中括号)这类坏 JSON。开了 JSON 模式仍不能保证 100%,
 * 而一次生成里任何一个角色崩掉,整条链路就废了。
 *
 * 处理方式与代码自愈完全同构 —— 把真实的解析错误和它自己的原始输出还给它,让它改。
 * 每次重试都是时间轴上一个独立节点,用户看得见它错过、也看得见它自己修好了。
 */
export async function callAgentParsed<T>(
  sink: EventSink,
  opts: AgentCallOptions,
  parse: (raw: string) => T,
  signal?: AbortSignal,
): Promise<T> {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
    const raw = await callAgent(sink, { ...opts, messages }, signal);
    try {
      return parse(raw);
    } catch (err) {
      lastErr = err;
      const reason = err instanceof Error ? err.message : String(err);
      // 让这次解析打回在时间轴上留痕 —— 悄悄重试等于把失败藏起来,
      // 审计需要看到「哪个角色被修正了第几次、因为什么错」
      sink.emit({
        type: "node.parse_retry",
        node: opts.node,
        attempt: attempt + 1,
        reason: reason.slice(0, 400),
      });
      messages.push({ role: "assistant", content: raw.slice(0, 4000) });
      messages.push({
        role: "user",
        content:
          `你上面的输出无法被使用,原因是:\n${reason.slice(0, 800)}\n\n` +
          `请严格按要求的格式重新输出,不要输出任何格式之外的文字。`,
      });
    }
  }
  throw lastErr instanceof Error
    ? new Error(`${opts.node} 连续 ${MAX_PARSE_RETRIES + 1} 次未能产出合法产物:${lastErr.message}`)
    : new Error(String(lastErr));
}

