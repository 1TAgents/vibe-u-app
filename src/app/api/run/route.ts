import { nanoid } from "nanoid";
import { runLoop } from "@/lib/orchestrator";
import { defaultModel } from "@/lib/llm";
import { sseResponse } from "@/lib/sse";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * 开一个新 run —— 主循环的入口。
 *
 * 这里不写任何流程:请求进来只做三件事,建记录、开事件流、把循环跑起来。
 * 「先写 PRD 还是先做设计」由 Piper 在循环里决定,不由路由决定。
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    prompt?: string;
    model?: string;
    scenarioId?: string;
  };
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) {
    return Response.json({ error: "说说你想要什么" }, { status: 400 });
  }

  const runId = nanoid(16);
  const model = body.model || defaultModel();
  const store = getStore();
  await store.createRun({
    id: runId,
    prompt,
    model,
    label: null,
    status: "running",
    totals: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  return sseResponse(
    runId,
    0,
    async (sink, signal) => {
      await runLoop(sink, { runId, request: prompt, model, scenarioId: body.scenarioId }, signal);
    },
    undefined,
    req.signal,
  );
}

/** 项目列表 —— 过滤掉验收沙箱产生的子 run */
export async function GET() {
  const runs = await getStore().listRuns(120);
  return Response.json({ runs });
}
