import { getStore } from "@/lib/store";

export const runtime = "nodejs";

const MAX_QUEUED_CHANGES = 8;
const MAX_CHANGE_LENGTH = 2000;

/** 当前任务周期不被硬抢占；老板的新要求先持久化，客户端在安全终态自动取下一条。 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  const body = (await req.json()) as { text?: string };
  const text = (body.text ?? "").trim();
  if (!text) return Response.json({ error: "说说要改什么" }, { status: 400 });
  if (text.length > MAX_CHANGE_LENGTH) {
    return Response.json(
      { error: `单条要求不能超过 ${MAX_CHANGE_LENGTH} 个字符` },
      { status: 400 },
    );
  }

  const store = getStore();
  const run = await store.getRun(runId);
  if (!run) return Response.json({ error: "项目不存在" }, { status: 404 });

  const queue = await store.listQueuedChanges(runId);
  if (queue.length >= MAX_QUEUED_CHANGES) {
    return Response.json(
      { error: `已有 ${MAX_QUEUED_CHANGES} 条要求等待处理，请先让团队消化` },
      { status: 409 },
    );
  }

  const item = await store.enqueueChange(runId, text);
  return Response.json({ item }, { status: 201 });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  const store = getStore();
  const run = await store.getRun(runId);
  if (!run) {
    return Response.json({ error: "项目不存在" }, { status: 404 });
  }
  let queue = await store.listQueuedChanges(runId);
  // 进程异常退出时 processing 可能没来得及回滚；只要 run 已经不在执行，就安全恢复为待处理。
  if (run.status !== "running") {
    await Promise.all(
      queue
        .filter((item) => item.status === "processing")
        .map((item) => store.setQueuedChangeStatus(runId, item.id, "pending")),
    );
    queue = queue.map((item) =>
      item.status === "processing" ? { ...item, status: "pending" as const } : item,
    );
  }
  return Response.json({ queue });
}

/** 只允许撤回还没开工的要求；processing 已进入正式工作流，不能伪装成可撤销。 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  const queueId = new URL(req.url).searchParams.get("id")?.trim();
  if (!queueId) {
    return Response.json({ error: "缺少要删除的排队任务" }, { status: 400 });
  }

  const store = getStore();
  const run = await store.getRun(runId);
  if (!run) return Response.json({ error: "项目不存在" }, { status: 404 });

  const item = (await store.listQueuedChanges(runId)).find(
    (change) => change.id === queueId,
  );
  if (!item) {
    return Response.json({ error: "这条任务已不在待处理队列中" }, { status: 404 });
  }
  if (item.status !== "pending") {
    return Response.json(
      { error: "这条任务已经开始处理，不能从队列删除" },
      { status: 409 },
    );
  }

  // 读状态与删除之间可能恰好被另一个页面认领；删除本身必须再次按 pending 原子过滤。
  const removed = await store.removePendingQueuedChange(runId, queueId);
  if (!removed) {
    return Response.json(
      { error: "这条任务已经开始处理，不能从队列删除" },
      { status: 409 },
    );
  }
  return Response.json({ ok: true, id: queueId });
}
