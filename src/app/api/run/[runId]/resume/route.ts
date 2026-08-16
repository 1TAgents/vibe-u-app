import { emptyBudget } from "@/lib/budget";
import { foldEvents } from "@/lib/fold";
import { runLoop } from "@/lib/orchestrator";
import { PrdSchema } from "@/lib/roles";
import { sseResponse } from "@/lib/sse";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 800;

/** 需求审核后的续跑入口：用户可以批准原 PRD，也可以直接改写后批准。 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  const body = (await req.json()) as {
    decision?: "approved" | "rejected";
    prd?: unknown;
  };
  if (body.decision !== "approved" && body.decision !== "rejected") {
    return Response.json({ error: "无效的审核决定" }, { status: 400 });
  }

  const store = getStore();
  const [run, events] = await Promise.all([
    store.getRun(runId),
    store.readEvents(runId),
  ]);
  if (!run) return Response.json({ error: "项目不存在" }, { status: 404 });
  if (run.status !== "awaiting_approval") {
    return Response.json({ error: "当前项目不在需求审核阶段" }, { status: 409 });
  }

  const state = foldEvents(events);
  if (!state.prd) return Response.json({ error: "找不到待审核的 PRD" }, { status: 409 });
  const approvedPrd = body.decision === "approved"
    ? PrdSchema.parse(body.prd ?? state.prd)
    : state.prd;
  const edited = JSON.stringify(approvedPrd) !== JSON.stringify(state.prd);
  const startSeq = events.reduce((max, env) => Math.max(max, env.seq + 1), 0);

  await store.updateRun(runId, {
    status: body.decision === "approved" ? "running" : "failed",
  });

  return sseResponse(
    runId,
    startSeq,
    async (sink, signal) => {
      sink.emit({
        type: "hitl.resolved",
        node: "pm",
        decision: body.decision!,
        edited,
      });

      if (body.decision === "rejected") {
        sink.emit({ type: "run.finished", status: "failed", totals: sink.totals });
        await store.updateRun(runId, { status: "failed", totals: sink.totals });
        return;
      }

      if (edited) sink.emit({ type: "artifact", kind: "prd", data: approvedPrd });
      await runLoop(
        sink,
        {
          runId,
          request: run.prompt,
          model: run.model,
          emitRunStarted: false,
          initial: {
            prd: approvedPrd,
            files: [],
            screenNames: [],
            facts: [edited ? "老板修改并批准了 PRD" : "老板已批准 PRD"],
            gatesPassed: true,
            qaPassed: false,
            accepted: false,
            attempts: [],
            budget: emptyBudget(),
          },
        },
        signal,
      );
    },
    state.totals,
    req.signal,
  );
}
