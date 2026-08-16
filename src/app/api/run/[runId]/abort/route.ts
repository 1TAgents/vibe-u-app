import type { Envelope, RunEvent } from "@/lib/events";
import { foldEvents } from "@/lib/fold";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

/**
 * 显式终止一个 run。
 *
 * 场景:自动生成管线跑完 QA 后会发出 verify.started,然后**等外部浏览器探针回报**;
 * 这期间 run 的状态是 running。验证台(runner)若在硬门处判了死刑 —— 比如 QA 难点没被
 * 用例覆盖、或运行时冒烟失败 —— 它不会再来汇报 verify,这个 run 就会永远挂在
 * 「running + verify.started」上,成为审计里的假运行。
 *
 * 这个接口给调用方一个显式的终态收尾:追加一条 run.aborted 并落库 status=aborted。
 * 幂等:已经到 succeeded / failed / aborted 的 run 直接返回,不重复追加事件。
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  const body = (await req.json()) as { reason?: string };
  const reason = (body?.reason ?? "").trim() || "run 被显式终止(未走完验证发布链路)";

  const store = getStore();
  const events = await store.readEvents(runId);
  if (events.length === 0) {
    return Response.json({ error: "run 不存在" }, { status: 404 });
  }
  const state = foldEvents(events);

  const terminal =
    state.finished === "succeeded"
      ? "succeeded"
      : state.finished === "failed"
        ? "failed"
        : state.aborted
          ? "aborted"
          : null;
  if (terminal) {
    return Response.json({ ok: true, idempotent: true, status: terminal });
  }

  const batch: Envelope<RunEvent>[] = [];
  const seq = state.lastSeq + 1;
  batch.push({ runId, seq, ts: Date.now(), event: { type: "run.aborted", reason } });

  await store.appendEvents(runId, batch);
  await store.updateRun(runId, { status: "aborted" });

  return Response.json({ ok: true, idempotent: false, status: "aborted", reason });
}
