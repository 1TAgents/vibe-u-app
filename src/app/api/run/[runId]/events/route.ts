import { getStore } from "@/lib/store";

export const runtime = "nodejs";

/** 回放数据源:整条事件流原样返回,前端 fold 到任意一帧 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  const store = getStore();
  const [run, events] = await Promise.all([
    store.getRun(runId),
    store.readEvents(runId),
  ]);
  if (!run) {
    return Response.json({ error: "run 不存在" }, { status: 404 });
  }
  return Response.json({ run, events });
}
