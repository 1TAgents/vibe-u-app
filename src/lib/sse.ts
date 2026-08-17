/**
 * SSE 传输层。
 *
 * 每个阶段(PM / 设计+编码 / 修复)都是一次独立的 SSE 请求,请求结束流即关闭。
 * 这样做的代价是多了几次往返,换来的是:阶段之间不依赖任何进程内存,
 * 任意一次中断都能靠事件流 fold 恢复,且天然适配无状态的 Serverless 部署。
 *
 * 取消语义:
 *  - 外部 signal(路由的 req.signal)或客户端断开(ReadableStream cancel)
 *    都会触发内部 AbortController,传给 work 的角色调用 —— 模型请求立即被打断,
 *    不再继续烧 token。
 *  - run 的终态区分两种停止:业务异常 → `failed`;用户/客户端取消 → `aborted`。
 *    两者都如实进事件流(run.aborted + reason),回放能看出为什么停下。
 */

import { EMPTY_USAGE, type Envelope, type RunEvent, type Usage } from "./events";
import { EventSink } from "./sink";
import { getStore } from "./store";

export function sseResponse(
  runId: string,
  startSeq: number,
  work: (sink: EventSink, signal: AbortSignal) => Promise<void>,
  priorUsage: Usage = EMPTY_USAGE,
  signal?: AbortSignal,
): Response {
  const encoder = new TextEncoder();

  // 内部取消源:外部 signal 与客户端断开都会汇聚到这里,
  // 让 work 里的模型调用在信号触发的那一刻就被打断。
  const ac = new AbortController();
  const onExternalAbort = () => {
    const reason = signal?.reason instanceof Error ? signal.reason : new Error("请求已取消");
    ac.abort(reason);
  };
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // LLM 改为非流式后，一个角色可能几十秒没有业务事件。心跳只维持传输连接，
      // 不经过 EventSink、不写数据库，也不触发前端状态刷新。
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          closed = true;
        }
      }, 15_000);
      const push = (env: Envelope<RunEvent>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(env)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const sink = new EventSink(runId, push, startSeq, priorUsage);

      try {
        await work(sink, ac.signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 失败也要进事件流:回放时必须能看到它是怎么失败的
        sink.emit({ type: "run.aborted", reason: message });
        // 异常路径要把 run 从「running」推到终态 —— 否则失败运行会在历史里永远显示 running。
        // 业务异常是 failed;用户/客户端取消是 aborted,两种停止语义分开记账。
        const terminal: "failed" | "aborted" = ac.signal.aborted ? "aborted" : "failed";
        await getStore()
          .updateRun(runId, { status: terminal, totals: sink.totals })
          .catch(() => {});
      } finally {
        clearInterval(heartbeat);
        signal?.removeEventListener("abort", onExternalAbort);
        await sink.flush();
        // 每个阶段结束都把成本写回 —— 停在审批门或中途断掉的生成
        // 也必须如实显示它已经花掉的钱
        await getStore()
          .updateRun(runId, { totals: sink.totals })
          .catch(() => {});
        if (!closed) {
          try {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {
            /* 客户端已断开或流已被取消 */
          }
          closed = true;
        }
      }
    },
    // 客户端停止读取即视为主动取消:打断正在跑的模型调用,不让它在服务端继续烧 token
    cancel(reason) {
      ac.abort(reason instanceof Error ? reason : new Error("客户端已断开"));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** 生成物沙箱运行在异源 iframe 里,数据接口需要放行跨源访问 */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
