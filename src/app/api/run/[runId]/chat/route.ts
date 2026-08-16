import { appHtml, buildApp } from "@/lib/builder";
import { emptyBudget } from "@/lib/budget";
import { foldEvents } from "@/lib/fold";
import { runLoop } from "@/lib/orchestrator";
import { withRuntimeFiles } from "@/lib/runtime-files";
import { sseResponse } from "@/lib/sse";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * 在同一个项目事件流里追加一轮需求变更。
 *
 * 不复制旧版固定的 intake → designer → engineer 流程。旧产物与老板的新要求
 * 一起还原给 Piper，由它重新决定责任人；平台只做两件确定的事：旧验收失效、
 * 新一轮仍必须重新构建、功能验收和交付验收。
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  const body = (await req.json()) as { text?: string };
  const text = (body.text ?? "").trim();
  if (!text) return Response.json({ error: "说说要改什么" }, { status: 400 });

  const store = getStore();
  const [run, events] = await Promise.all([
    store.getRun(runId),
    store.readEvents(runId),
  ]);
  if (!run) return Response.json({ error: "项目不存在" }, { status: 404 });
  if (run.status === "running") {
    return Response.json({ error: "团队仍在推进，请等当前一轮结束" }, { status: 409 });
  }

  const state = foldEvents(events);
  if (!state.prd || !state.visual || !state.design || state.files.length === 0) {
    return Response.json({ error: "当前项目还没有足够产物，无法继续修改" }, { status: 409 });
  }
  const prd = state.prd;
  const visual = state.visual;
  const design = state.design;

  const files = withRuntimeFiles(state.files);
  const built = await buildApp(files);
  const startSeq = events.reduce((max, env) => Math.max(max, env.seq + 1), 0);
  const turn = state.turn + 1;
  const followUps = [...state.chat.map((item) => item.text), text];
  await store.updateRun(runId, { status: "running" });

  return sseResponse(
    runId,
    startSeq,
    async (sink, signal) => {
      sink.emit({ type: "chat.user", text, turn });
      const result = await runLoop(
        sink,
        {
          runId,
          request: run.prompt,
          model: run.model,
          followUps,
          initial: {
            prd,
            visual,
            design,
            files,
            cases: state.testCases,
            built: built.ok ? built : undefined,
            html: built.ok
              ? appHtml({
                  title: prd.title,
                  js: built.js,
                  css: built.css,
                  runId,
                  apiBase: "",
                  embed: true,
                })
              : undefined,
            screenNames: [],
            facts: [
              `老板追加要求：${text}`,
              "旧版本的功能与交付验收已失效，本轮修改后必须重新验证。",
              ...(!built.ok ? built.errors.map((e) => `当前代码构建失败：${e.message}`) : []),
            ],
            gatesPassed: false,
            qaPassed: false,
            accepted: false,
            attempts: [],
            budget: emptyBudget(),
          },
        },
        signal,
      );
      sink.emit({
        type: "chat.done",
        turn,
        summary:
          result.status === "succeeded"
            ? "这轮需求变更已重新通过构建、功能验收和交付验收"
            : "这轮需求变更已停止，详细原因见 Piper 的交接记录",
        changed: result.files.map((file) => file.path),
      });
    },
    run.totals,
    req.signal,
  );
}
