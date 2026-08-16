/**
 * 生成物的数据服务(对标 Atoms Cloud Backend)的核心逻辑。
 *
 * 单独抽出来是因为它有两个调用方:
 *   1. HTTP 路由 —— 生成物在浏览器里通过 fetch 访问
 *   2. 测试执行器 —— 在服务端 jsdom 里跑验收测试时,拦掉 fetch 直接调这里
 *
 * 两者必须走同一份实现。如果测试环境用的是另一套模拟数据层,
 * 那测试通过就说明不了线上能用 —— 测试环境和生产环境的差异
 * 恰恰是最容易掩盖真实缺陷的地方。
 */

import { getStore, type AppRow } from "./store";

export type AppDataMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface AppDataResult {
  status: number;
  body: AppRow | AppRow[] | { ok: true } | { error: string };
}

export async function handleAppData(
  runId: string,
  collection: string,
  method: AppDataMethod,
  body: unknown,
): Promise<AppDataResult> {
  const store = getStore();

  switch (method) {
    case "GET":
      return { status: 200, body: await store.appList(runId, collection) };

    case "POST":
      return {
        status: 200,
        body: await store.appInsert(runId, collection, (body ?? {}) as Record<string, unknown>),
      };

    case "PATCH": {
      const b = (body ?? {}) as { id?: string; patch?: Record<string, unknown> };
      if (!b.id) return { status: 400, body: { error: "缺少 id" } };
      const row = await store.appUpdate(runId, collection, b.id, b.patch ?? {});
      return row
        ? { status: 200, body: row }
        : { status: 404, body: { error: "记录不存在" } };
    }

    case "DELETE": {
      const b = (body ?? {}) as { id?: string };
      if (!b.id) return { status: 400, body: { error: "缺少 id" } };
      await store.appRemove(runId, collection, b.id);
      return { status: 200, body: { ok: true } };
    }
  }
}

/** 从生成物发出的 URL 里解出 runId 与 collection */
export function parseAppDataUrl(
  url: string,
): { runId: string; collection: string } | null {
  const m = url.match(/\/api\/appdata\/([^/?#]+)\/([^/?#]+)/);
  if (!m) return null;
  return {
    runId: decodeURIComponent(m[1]),
    collection: decodeURIComponent(m[2]),
  };
}
