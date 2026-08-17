import { handleAppData, type AppDataMethod } from "@/lib/appdata";
import { CORS_HEADERS } from "@/lib/sse";

export const runtime = "nodejs";

/**
 * 生成应用的数据服务。
 *
 * 真正的读写逻辑在 lib/appdata.ts —— 那里同时被服务端的验收测试执行器调用,
 * 保证「测试里跑的」和「线上跑的」是同一份实现。
 *
 * 数据按 runId 隔离:每次生成的应用有自己独立的数据空间,互不串扰。
 */

type Ctx = { params: Promise<{ runId: string; collection: string }> };

async function run(req: Request, ctx: Ctx, method: AppDataMethod) {
  const { runId, collection } = await ctx.params;
  const body =
    method === "GET" ? undefined : await req.json().catch(() => ({}));
  const result = await handleAppData(runId, collection, method, body);
  return Response.json(result.body, {
    status: result.status,
    headers: CORS_HEADERS,
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export const GET = (req: Request, ctx: Ctx) => run(req, ctx, "GET");
export const POST = (req: Request, ctx: Ctx) => run(req, ctx, "POST");
export const PATCH = (req: Request, ctx: Ctx) => run(req, ctx, "PATCH");
export const DELETE = (req: Request, ctx: Ctx) => run(req, ctx, "DELETE");
