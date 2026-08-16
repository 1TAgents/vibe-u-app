/**
 * OpenAI 兼容的流式客户端。
 *
 * 为什么手写而不用 Vercel AI SDK / openai-node:
 * 1. 本项目的核心卖点是可观测性,需要拿到 `reasoning_content` 这类**非标准字段**。
 *    通用 SDK 会把它抹平或吞掉,而它恰恰是最有价值的观测信号。
 * 2. 需要精确的逐块 usage 与耗时归因,SDK 的抽象层会让归因变模糊。
 * 3. 只依赖 fetch,本地 new-api 网关和线上任意 OpenAI 兼容端点换两个环境变量即可切换。
 */

import { EMPTY_USAGE, addUsage, type Usage } from "./events";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 每百万 token 美元单价。未列出的模型按 fallback 估算,成本面板会标注为估算值。 */
const PRICING: Record<string, { in: number; out: number }> = {
  "glm-5.2": { in: 0.6, out: 2.2 },
  "glm-5.1": { in: 0.6, out: 2.2 },
  "glm-5": { in: 0.6, out: 2.2 },
  "glm-4.7": { in: 0.3, out: 1.1 },
  "glm-4.7-flash": { in: 0, out: 0 },
  "deepseek-v4-pro": { in: 0.28, out: 0.42 },
  "deepseek-v4-flash": { in: 0.07, out: 0.28 },
  "gpt-4.1": { in: 2.0, out: 8.0 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4o": { in: 2.5, out: 10.0 },
  "o4-mini": { in: 1.1, out: 4.4 },
};

const FALLBACK_PRICE = { in: 0.5, out: 1.5 };

/** 单次 LLM 请求的最大尝试次数(含首次) */
const MAX_REQUEST_ATTEMPTS = 3;

/**
 * 指数退避;顺便把重试这件事告诉调用方,不让它静默发生。
 * 退避期间尊重 AbortSignal —— 用户取消时不能等完整个退避窗口才响应。
 */
async function backoff(attempt: number, cb: StreamCallbacks, signal?: AbortSignal) {
  const baseMs = Number(process.env.LLM_BACKOFF_BASE_MS ?? 800);
  const waitMs = baseMs * 2 ** (attempt - 1);
  // 进入退避前已经取消:直接拒绝,不等待 —— 监听器不会再收到 abort 事件
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("请求已取消");
  }
  cb.onRetry?.(attempt, waitMs);
  if (!signal) {
    await new Promise((r) => setTimeout(r, waitMs));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, waitMs);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("请求已取消"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isPricingKnown(model: string): boolean {
  return model in PRICING;
}

export function costOf(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICING[model] ?? FALLBACK_PRICE;
  return (promptTokens * p.in + completionTokens * p.out) / 1_000_000;
}

export interface StreamCallbacks {
  onReasoning?: (delta: string) => void;
  onContent?: (delta: string) => void;
  /** 请求层重试 —— 让上层能把它记进事件流,而不是悄悄发生 */
  onRetry?: (attempt: number, waitMs: number) => void;
  /**
   * 推理模式降级 —— 结构化角色一次「有 reasoning 但正文为空」后,下一次重试关闭 thinking。
   * 让上层把它记进事件流:降级原因与切换后的 thinking 模式都可审计。
   */
  onThinkingDegrade?: (info: ThinkingDegradeInfo) => void;
}

export interface ThinkingDegradeInfo {
  /** 降级后生效的第几次尝试(1-based) */
  attempt: number;
  /** 降级原因:spiral = 思考超阈值仍无正文;empty = 流正常结束但正文为空 */
  reason: "spiral" | "empty";
  /** 降级前的 thinking 模式(default = 请求体未显式传,网关默认 enabled) */
  from: "enabled" | "disabled" | "default";
  /** 降级后的 thinking 模式 */
  to: "disabled";
  /** 已被掐断/废弃尝试累计消耗的 token 与成本 —— 成本面板不丢 */
  wastedTokens: number;
  wastedCostUsd: number;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  usage: Usage;
  durationMs: number;
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      // 非标准字段:智谱 / DeepSeek 等推理模型经 new-api 透传
      reasoning_content?: string | null;
      reasoning?: string | null;
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

function baseUrl(): string {
  return (process.env.LLM_BASE_URL ?? "http://127.0.0.1:3000/v1").replace(/\/+$/, "");
}

function apiKey(): string {
  return process.env.LLM_API_KEY ?? "local";
}

export function defaultModel(): string {
  return process.env.LLM_MODEL ?? "glm-5.2";
}

/** Race Mode 的候选模型池 */
export function raceModels(): string[] {
  const raw = process.env.LLM_RACE_MODELS;
  if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ["glm-5.2", "deepseek-v4-pro", "gpt-4.1"];
}

/**
 * 流式调用。推理模型（glm-5.2 / deepseek-v4-pro）会先吐大量 reasoning token,
 * 若 maxTokens 给太小会出现"content 为空但 token 已耗尽"的静默失败,
 * 因此默认值给得比较宽松。
 */
export async function streamChat(
  opts: {
    model: string;
    messages: ChatMessage[];
    maxTokens?: number;
    temperature?: number;
    /** 开启 JSON 模式,从源头压掉"模型在 JSON 外面裹解释文字"的问题 */
    jsonMode?: boolean;
    signal?: AbortSignal;
    /**
     * 推理模式控制(DeepSeek V4 等 thinking 默认 enabled 的模型)。
     * 代码直出角色(Alex 的 engineer/fix/iterate)显式 `disabled`,长输出不用先烧完思考预算;
     * 其余角色保持默认 `enabled`。不传则请求体不带该字段,行为与网关默认一致。
     */
    thinking?: "enabled" | "disabled";
  },
  cb: StreamCallbacks = {},
): Promise<StreamResult> {
  const started = Date.now();

  /**
   * 退化响应后的推力提示 —— 追加到最后一次用户消息尾部。
   * 只思考不输出的模型常在下一轮继续空转;明确命令它「立刻直接输出」能打断循环。
   * 会随重试逐次增强,且最终记录的 prompt 就是实际发出去的(带提示的)版本,审计不失真。
   */
  let nudge = "";
  /**
   * 本次调用实际生效的 thinking 模式。初始等于调用方传入值(default = 未传,网关默认 enabled);
   * 一旦结构化角色发生空转/空正文,就在重试前把它降级为 "disabled" —— 下一次重试必须关掉 thinking。
   * `send` 读这个可变值(而不是 opts.thinking),降级才真正作用于后续请求体。
   */
  let currentThinking = opts.thinking;

  const send = (jsonMode: boolean) => {
    const messages: ChatMessage[] = nudge
      ? opts.messages.map((m, i) =>
          i === opts.messages.length - 1 ? { ...m, content: m.content + nudge } : m,
        )
      : opts.messages;
    return fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: opts.maxTokens ?? 16000,
        temperature: opts.temperature ?? 0.6,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        ...(currentThinking ? { thinking: { type: currentThinking } } : {}),
      }),
      signal: opts.signal,
    });
  };

  /**
   * 瞬时故障重试。
   *
   * 实测踩过:一次生成跑到第 9 分钟、烧掉 7.5 万 token,最后一步的 LLM 请求
   * 遇到一个 `fetch failed`(undici 的通用网络错误),整条链路直接作废。
   *
   * 网络抖动、网关 502、限流都是**必然会发生**的事,不是异常情况。
   * 一个跑十分钟的流程如果不能扛住一次抖动,它就不是可交付的东西。
   *
   * 只重试可恢复的:网络层抛错、429、5xx。4xx 是我们自己请求写错了,
   * 重试多少次都一样,应当立刻失败。
   */
  let lastErr: unknown;
  let useJsonMode = Boolean(opts.jsonMode);

  // 推理空转护栏:思考字符数超过这个阈值、正文却一个字没吐,判为螺旋,掐流重试。
  // 实测 deepseek-v4-flash 曾在写代码前烧完 48000 token 的思考、正文为空,直接报废整条运行。
  // 与其等 maxTokens 耗尽(慢且贵),不如在流里早点掐掉,换一次采样重来 ——
  // 与网络重试同一哲学:瞬时退化是必然发生的,流程必须扛得住。
  const REASONING_SPIRAL_CHARS = Number(process.env.REASONING_SPIRAL_CHARS ?? 30000);
  // 被掐掉的尝试已经消费了 token/成本,不能丢 —— 成功重试时累加进最终 usage,
  // 全部失败时挂到抛出的错误上,由调用方通过事件保留耗用,成本面板才不撒谎。
  const promptEstimate = Math.ceil(opts.messages.reduce((n, m) => n + m.content.length, 0) / 3);
  let wasted: Usage = { ...EMPTY_USAGE };

  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
    let res: Response | undefined;
    try {
      res = await send(useJsonMode);
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err;
      if (attempt === MAX_REQUEST_ATTEMPTS) {
        throw new Error(
          `LLM 请求连续 ${MAX_REQUEST_ATTEMPTS} 次失败:${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await backoff(attempt, cb, opts.signal);
      continue;
    }

    // 并非所有上游都支持 JSON 模式;被拒就降级重来,而不是让整条链路失败
    if (!res.ok && useJsonMode && (res.status === 400 || res.status === 422)) {
      useJsonMode = false;
      continue;
    }

    if (!res.ok || !res.body) {
      const retryable = res.status === 429 || res.status >= 500;
      const detail = await res.text().catch(() => "");
      if (!retryable || attempt === MAX_REQUEST_ATTEMPTS) {
        throw new Error(`LLM ${res.status}: ${detail.slice(0, 400)}`);
      }
      lastErr = new Error(`LLM ${res.status}`);
      await backoff(attempt, cb, opts.signal);
      continue;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let usage: Usage = { ...EMPTY_USAGE };
    let reasoningChars = 0;
    let contentChars = 0;
    let spiral = false;
    let aborted = false;

    try {
      while (true) {
        if (opts.signal?.aborted) {
          aborted = true;
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 以空行分帧;网络分片可能把一帧切断,所以保留最后一段不完整的内容
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let chunk: StreamChunk;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue; // 网关偶发的心跳/非 JSON 帧,跳过即可
          }

          const delta = chunk.choices?.[0]?.delta;
          if (delta) {
            const r = delta.reasoning_content ?? delta.reasoning;
            if (r) {
              reasoning += r;
              reasoningChars += r.length;
              cb.onReasoning?.(r);
            }
            if (delta.content) {
              content += delta.content;
              contentChars += delta.content.length;
              cb.onContent?.(delta.content);
            }
          }

          if (chunk.usage) {
            const pt = chunk.usage.prompt_tokens ?? 0;
            const ct = chunk.usage.completion_tokens ?? 0;
            usage = {
              promptTokens: pt,
              completionTokens: ct,
              reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? pt + ct,
              costUsd: costOf(opts.model, pt, ct),
            };
          }
        }

        // 推理空转:思考已烧掉一大段、正文还是零 —— 这是一条注定空转的流,掐掉重来
        if (contentChars === 0 && reasoningChars > REASONING_SPIRAL_CHARS) {
          spiral = true;
          break;
        }
      }
    } finally {
      if (spiral || aborted) reader.cancel().catch(() => {});
    }

    if (opts.signal?.aborted || aborted) {
      throw opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("请求已取消");
    }

    // 统一的退化响应处理:螺旋(思考超阈值仍无正文)或流正常结束后正文为空,
    // 都是「没产出东西」,一律视为可恢复的瞬时退化 —— 记录本次耗用后退避重试。
    // 空正文分两种:高思考(空转)与低思考(模型瞬时抽风),前者消耗可能很大,
    // 所以螺旋要在流里尽早掐掉;两者都按真实/估算 usage 计入 wasted,成本面板不丢。
    if (spiral || content.trim().length === 0) {
      const ct = Math.ceil((content.length + reasoning.length) / 3);
      const reasoningTokens = Math.ceil(reasoning.length / 3);
      const abandoned: Usage =
        usage.totalTokens > 0
          ? usage
          : {
              promptTokens: promptEstimate,
              completionTokens: ct,
              reasoningTokens,
              totalTokens: promptEstimate + ct,
              costUsd: costOf(opts.model, promptEstimate, ct),
            };
      wasted = addUsage(wasted, abandoned);

      if (attempt === MAX_REQUEST_ATTEMPTS) {
        const kind = spiral ? "推理空转" : "空响应";
        // 只报事实:思考量、尝试次数、累计废弃耗用 —— 低 token 空正文不是「预算耗尽」
        const reasoningTok = usage.reasoningTokens || reasoningTokens;
        const capped = reasoningTok > 0 && reasoningTok >= (opts.maxTokens ?? 16000) * 0.8;
        const hint = capped ? "思考几乎用尽 maxTokens,可考虑调高上限" : "思考量很小,更像模型瞬时退化";
        const err = new Error(
          `${kind}:模型连续 ${MAX_REQUEST_ATTEMPTS} 次未产出正文` +
            `(本次思考约 ${reasoningTok} tok,${hint};` +
            `累计废弃约 ${wasted.totalTokens} tok / $${wasted.costUsd.toFixed(4)})`,
        ) as Error & { usage?: Usage };
        err.usage = wasted;
        throw err;
      }
      // 推理模式降级:结构化角色一次「有 reasoning 但正文为空/推理空转」后,
      // 下一次重试必须 thinking=disabled —— 只思考不输出的模型常在下一轮继续空转,
      // 关掉 thinking 从源头掐断螺旋,而不是继续陪它烧思考预算。
      // 普通网络/解析错误走各自的路径,不经过这里,thinking 保持原策略。
      if (attempt < MAX_REQUEST_ATTEMPTS && currentThinking !== "disabled") {
        const from = currentThinking ?? "default";
        currentThinking = "disabled";
        cb.onThinkingDegrade?.({
          attempt: attempt + 1,
          reason: spiral ? "spiral" : "empty",
          from,
          to: "disabled",
          wastedTokens: wasted.totalTokens,
          wastedCostUsd: wasted.costUsd,
        });
      }
      // 换一次采样重来(思考产物会被丢弃);同时追加推力提示打断空转/空响应循环
      nudge = spiral
        ? "\n\n[系统] 你上一轮陷入思考循环,只输出了推理、没有任何正文。请立刻直接开始输出最终答案,不要再继续思考。"
        : "\n\n[系统] 你上一轮返回了空内容。请直接输出最终答案,不要留空。";
      await backoff(attempt, cb, opts.signal);
      continue;
    }

    // 部分网关不返回 usage,用字符数粗估,保证成本面板始终有数
    if (usage.totalTokens === 0) {
      const pt = Math.ceil(opts.messages.reduce((n, m) => n + m.content.length, 0) / 3);
      const ct = Math.ceil((content.length + reasoning.length) / 3);
      usage = {
        promptTokens: pt,
        completionTokens: ct,
        reasoningTokens: Math.ceil(reasoning.length / 3),
        totalTokens: pt + ct,
        costUsd: costOf(opts.model, pt, ct),
      };
    }

    // 成功重试:废弃尝试的耗用必须算进最终 usage,成本面板才真实
    return { content, reasoning, usage: addUsage(usage, wasted), durationMs: Date.now() - started };
  }

  throw lastErr instanceof Error ? lastErr : new Error("LLM 请求失败");
}

/**
 * 从模型输出里抠 JSON。
 * 推理模型经常在 JSON 前后带解释性文字或 ```json 围栏,直接 JSON.parse 会炸。
 * 这里按"围栏 → 首个平衡括号 → 裸解析"三级降级。
 */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], balancedSlice(raw), raw].filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  );
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(`模型未返回可解析 JSON,原始输出前 300 字:${raw.slice(0, 300)}`);
}

/** 找出第一个括号平衡的 {...} 或 [...] 片段 */
function balancedSlice(s: string): string | undefined {
  const start = s.search(/[{[]/);
  if (start < 0) return undefined;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}
