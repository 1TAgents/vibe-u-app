/**
 * 持久化层。
 *
 * 选型说明:这里没有引 ORM,而是定义了一个小型 Store 接口 + 两个适配器。
 * - 本地开发:JSONL + JSON 文件,零依赖零配置,克隆下来就能跑,不需要装数据库。
 * - 线上部署:设置 DATABASE_URL 即走 Neon Postgres(serverless driver,适配 Vercel)。
 *
 * 为什么不上 Drizzle/Prisma:本项目的存储需求是"追加事件 + 按 runId 读回",
 * 四张表、没有联表、迁移很轻。引 ORM 换来的类型收益抵不过它在两种运行时下的配置成本。
 * 接口隔离已经让适配器可替换,这比 ORM 更贴近实际约束。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import type { Envelope, RunEvent, RunStatus, Usage } from "./events";
import { EMPTY_USAGE } from "./events";

export interface RunRecord {
  id: string;
  prompt: string;
  model: string;
  label: string | null;
  status: RunStatus;
  totals: Usage;
  createdAt: number;
  updatedAt: number;
}

export interface AppRow {
  id: string;
  createdAt: number;
  [k: string]: unknown;
}

/**
 * 已编译应用的自包含产物。
 *
 * candidate 给工作区预览和浏览器校验使用；published 是最近一次通过校验的稳定版本。
 * 两者分离后，用户继续修改应用时，公开链接不会短暂暴露尚未验收的新代码。
 */
export interface AppBundle {
  js: string;
  css: string;
  bytes: number;
  updatedAt: number;
}

export type AppBundleStage = "candidate" | "published";

export interface Store {
  createRun(r: RunRecord): Promise<void>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(limit: number): Promise<RunRecord[]>;
  appendEvents(runId: string, events: Envelope<RunEvent>[]): Promise<void>;
  readEvents(runId: string): Promise<Envelope<RunEvent>[]>;

  /** 保存候选构建；只有浏览器校验通过后才会晋升为公开版本。 */
  saveAppBundle(runId: string, bundle: AppBundle): Promise<void>;
  publishAppBundle(runId: string): Promise<void>;
  getAppBundle(runId: string, stage: AppBundleStage): Promise<AppBundle | null>;

  /** 生成物的数据 —— 让被生成的应用拥有真实、跨会话的持久化 */
  appList(runId: string, collection: string): Promise<AppRow[]>;
  appInsert(runId: string, collection: string, data: Record<string, unknown>): Promise<AppRow>;
  appUpdate(
    runId: string,
    collection: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<AppRow | null>;
  appRemove(runId: string, collection: string, id: string): Promise<boolean>;
}

/* ----------------------------- 文件适配器 ----------------------------- */

const DATA_DIR = path.join(process.cwd(), ".data");

class FileStore implements Store {
  private lock: Promise<unknown> = Promise.resolve();

  /** 串行化写入,避免并发追加把 JSONL 写坏 */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => {});
    return next;
  }

  private runDir(id: string) {
    return path.join(DATA_DIR, "runs", id);
  }

  async createRun(r: RunRecord) {
    await this.serialize(async () => {
      await fs.mkdir(this.runDir(r.id), { recursive: true });
      await fs.writeFile(path.join(this.runDir(r.id), "run.json"), JSON.stringify(r, null, 2));
    });
  }

  async updateRun(id: string, patch: Partial<RunRecord>) {
    await this.serialize(async () => {
      const cur = await this.readRunFile(id);
      if (!cur) return;
      const next = { ...cur, ...patch, updatedAt: Date.now() };
      await fs.writeFile(path.join(this.runDir(id), "run.json"), JSON.stringify(next, null, 2));
    });
  }

  private async readRunFile(id: string): Promise<RunRecord | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.runDir(id), "run.json"), "utf8"));
    } catch {
      return null;
    }
  }

  getRun(id: string) {
    return this.readRunFile(id);
  }

  async listRuns(limit: number) {
    let ids: string[];
    try {
      ids = await fs.readdir(path.join(DATA_DIR, "runs"));
    } catch {
      return [];
    }
    const runs = (await Promise.all(ids.map((i) => this.readRunFile(i)))).filter(
      (r): r is RunRecord => r !== null,
    );
    return runs.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async appendEvents(runId: string, events: Envelope<RunEvent>[]) {
    if (events.length === 0) return;
    await this.serialize(async () => {
      await fs.mkdir(this.runDir(runId), { recursive: true });
      await fs.appendFile(
        path.join(this.runDir(runId), "events.jsonl"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    });
  }

  async readEvents(runId: string) {
    try {
      const raw = await fs.readFile(path.join(this.runDir(runId), "events.jsonl"), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Envelope<RunEvent>);
    } catch {
      return [];
    }
  }

  private bundleFile(runId: string) {
    return path.join(this.runDir(runId), "app-bundle.json");
  }

  private async readBundles(
    runId: string,
  ): Promise<{ candidate: AppBundle | null; published: AppBundle | null }> {
    try {
      return JSON.parse(await fs.readFile(this.bundleFile(runId), "utf8"));
    } catch {
      return { candidate: null, published: null };
    }
  }

  async saveAppBundle(runId: string, bundle: AppBundle) {
    await this.serialize(async () => {
      const current = await this.readBundles(runId);
      await fs.mkdir(this.runDir(runId), { recursive: true });
      await fs.writeFile(
        this.bundleFile(runId),
        JSON.stringify({ ...current, candidate: bundle }),
      );
    });
  }

  async publishAppBundle(runId: string) {
    await this.serialize(async () => {
      const current = await this.readBundles(runId);
      if (!current.candidate) return;
      await fs.writeFile(
        this.bundleFile(runId),
        JSON.stringify({ ...current, published: current.candidate }),
      );
    });
  }

  async getAppBundle(runId: string, stage: AppBundleStage) {
    return (await this.readBundles(runId))[stage] ?? null;
  }

  private appFile(runId: string, collection: string) {
    return path.join(this.runDir(runId), "app", `${sanitize(collection)}.json`);
  }

  private async readApp(runId: string, collection: string): Promise<AppRow[]> {
    try {
      return JSON.parse(await fs.readFile(this.appFile(runId, collection), "utf8"));
    } catch {
      return [];
    }
  }

  private async writeApp(runId: string, collection: string, rows: AppRow[]) {
    const f = this.appFile(runId, collection);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, JSON.stringify(rows, null, 2));
  }

  appList(runId: string, collection: string) {
    return this.readApp(runId, collection);
  }

  async appInsert(runId: string, collection: string, data: Record<string, unknown>) {
    return this.serialize(async () => {
      const rows = await this.readApp(runId, collection);
      const row: AppRow = { ...data, id: randomId(), createdAt: Date.now() };
      rows.push(row);
      await this.writeApp(runId, collection, rows);
      return row;
    });
  }

  async appUpdate(
    runId: string,
    collection: string,
    id: string,
    patch: Record<string, unknown>,
  ) {
    return this.serialize(async () => {
      const rows = await this.readApp(runId, collection);
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return null;
      rows[i] = { ...rows[i], ...patch, id: rows[i].id, createdAt: rows[i].createdAt };
      await this.writeApp(runId, collection, rows);
      return rows[i];
    });
  }

  async appRemove(runId: string, collection: string, id: string) {
    return this.serialize(async () => {
      const rows = await this.readApp(runId, collection);
      const next = rows.filter((r) => r.id !== id);
      if (next.length === rows.length) return false;
      await this.writeApp(runId, collection, next);
      return true;
    });
  }
}

/* --------------------------- Postgres 适配器 --------------------------- */

export type SqlFn = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>;

export class PgStore implements Store {
  private ready: Promise<void>;

  constructor(private sql: SqlFn) {
    this.ready = this.migrate();
  }

  private async migrate() {
    await this.sql`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL,
        totals JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL,
        seq INT NOT NULL,
        ts BIGINT NOT NULL,
        event JSONB NOT NULL,
        PRIMARY KEY (run_id, seq)
      )`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS app_rows (
        run_id TEXT NOT NULL,
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        ord BIGSERIAL,
        PRIMARY KEY (run_id, collection, id)
      )`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS app_bundles (
        run_id TEXT PRIMARY KEY,
        candidate JSONB,
        published JSONB,
        updated_at BIGINT NOT NULL
      )`;
    // 兼容早于 ord 列的既有部署;IF NOT EXISTS 让这句可以反复执行
    await this.sql`ALTER TABLE app_rows ADD COLUMN IF NOT EXISTS ord BIGSERIAL`;
  }

  async createRun(r: RunRecord) {
    await this.ready;
    await this.sql`
      INSERT INTO runs (id, prompt, model, label, status, totals, created_at, updated_at)
      VALUES (${r.id}, ${r.prompt}, ${r.model}, ${r.label}, ${r.status},
              ${JSON.stringify(r.totals)}, ${r.createdAt}, ${r.updatedAt})
      ON CONFLICT (id) DO NOTHING`;
  }

  async updateRun(id: string, patch: Partial<RunRecord>) {
    await this.ready;
    const cur = await this.getRun(id);
    if (!cur) return;
    const n = { ...cur, ...patch, updatedAt: Date.now() };
    await this.sql`
      UPDATE runs SET status = ${n.status}, totals = ${JSON.stringify(n.totals)},
                      label = ${n.label}, updated_at = ${n.updatedAt}
      WHERE id = ${id}`;
  }

  async getRun(id: string) {
    await this.ready;
    const rows = await this.sql`SELECT * FROM runs WHERE id = ${id}`;
    return rows[0] ? rowToRun(rows[0]) : null;
  }

  async listRuns(limit: number) {
    await this.ready;
    // id 作为并列兜底:Race Mode 会在同一毫秒创建多个 run,否则列表顺序不稳定
    const rows = await this.sql`
      SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    return rows.map(rowToRun);
  }

  async appendEvents(runId: string, events: Envelope<RunEvent>[]) {
    await this.ready;
    for (const e of events) {
      await this.sql`
        INSERT INTO run_events (run_id, seq, ts, event)
        VALUES (${e.runId}, ${e.seq}, ${e.ts}, ${JSON.stringify(e.event)})
        ON CONFLICT (run_id, seq) DO NOTHING`;
    }
  }

  async readEvents(runId: string) {
    await this.ready;
    const rows = await this.sql`SELECT * FROM run_events WHERE run_id = ${runId} ORDER BY seq ASC`;
    return rows.map((r) => ({
      runId: r.run_id as string,
      seq: Number(r.seq),
      ts: Number(r.ts),
      event: r.event as RunEvent,
    }));
  }

  async saveAppBundle(runId: string, bundle: AppBundle) {
    await this.ready;
    await this.sql`
      INSERT INTO app_bundles (run_id, candidate, published, updated_at)
      VALUES (${runId}, ${JSON.stringify(bundle)}, ${null}, ${bundle.updatedAt})
      ON CONFLICT (run_id) DO UPDATE
      SET candidate = EXCLUDED.candidate, updated_at = EXCLUDED.updated_at`;
  }

  async publishAppBundle(runId: string) {
    await this.ready;
    await this.sql`
      UPDATE app_bundles
      SET published = candidate, updated_at = ${Date.now()}
      WHERE run_id = ${runId} AND candidate IS NOT NULL`;
  }

  async getAppBundle(runId: string, stage: AppBundleStage) {
    await this.ready;
    const rows =
      stage === "candidate"
        ? await this.sql`SELECT candidate AS bundle FROM app_bundles WHERE run_id = ${runId}`
        : await this.sql`SELECT published AS bundle FROM app_bundles WHERE run_id = ${runId}`;
    if (!rows[0]?.bundle) return null;
    const value = rows[0].bundle;
    return (typeof value === "string" ? JSON.parse(value) : value) as AppBundle;
  }

  async appList(runId: string, collection: string) {
    await this.ready;
    // 按自增序列而不是 created_at 排序。
    // 同一毫秒内插入的多条记录 created_at 完全相同,Postgres 对并列行不保证任何顺序,
    // 结果是生成物里的列表会随机乱序 —— 而文件存储是数组追加、天然保序,
    // 所以这个 bug 只会在线上出现。ord 是 BIGSERIAL,严格反映插入先后。
    const rows = await this.sql`
      SELECT * FROM app_rows WHERE run_id = ${runId} AND collection = ${collection}
      ORDER BY ord ASC`;
    return rows.map(rowToApp);
  }

  async appInsert(runId: string, collection: string, data: Record<string, unknown>) {
    await this.ready;
    const row: AppRow = { ...data, id: randomId(), createdAt: Date.now() };
    await this.sql`
      INSERT INTO app_rows (run_id, collection, id, data, created_at)
      VALUES (${runId}, ${collection}, ${row.id}, ${JSON.stringify(data)}, ${row.createdAt})`;
    return row;
  }

  async appUpdate(
    runId: string,
    collection: string,
    id: string,
    patch: Record<string, unknown>,
  ) {
    await this.ready;
    const rows = await this.sql`
      SELECT * FROM app_rows WHERE run_id = ${runId} AND collection = ${collection} AND id = ${id}`;
    if (!rows[0]) return null;
    const merged = { ...(rows[0].data as Record<string, unknown>), ...patch };
    await this.sql`
      UPDATE app_rows SET data = ${JSON.stringify(merged)}
      WHERE run_id = ${runId} AND collection = ${collection} AND id = ${id}`;
    return { ...merged, id, createdAt: Number(rows[0].created_at) } as AppRow;
  }

  async appRemove(runId: string, collection: string, id: string) {
    await this.ready;
    await this.sql`
      DELETE FROM app_rows WHERE run_id = ${runId} AND collection = ${collection} AND id = ${id}`;
    return true;
  }
}

function rowToRun(r: Record<string, unknown>): RunRecord {
  return {
    id: r.id as string,
    prompt: r.prompt as string,
    model: r.model as string,
    label: (r.label as string) ?? null,
    status: r.status as RunStatus,
    totals: (r.totals as Usage) ?? EMPTY_USAGE,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToApp(r: Record<string, unknown>): AppRow {
  return {
    ...(r.data as Record<string, unknown>),
    id: r.id as string,
    createdAt: Number(r.created_at),
  };
}

/* ------------------------------- 出口 ------------------------------- */

function sanitize(s: string) {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default";
}

export function randomId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  );
}

let cached: Store | null = null;

/**
 * 适配器选择:配了 DATABASE_URL 走 Postgres,否则走本地文件。
 *
 * 这里曾经用 `require()` 做条件加载,想着"本地不配库就不加载驱动"。那是个会 100% 炸掉
 * 生产的 bug —— 路由被打包成 ESM,`require` 在那里根本不存在;而本地因为不配
 * DATABASE_URL 永远走不到那一行,于是本地怎么测都是绿的,一上线必挂。
 *
 * 改成静态 import。@neondatabase/serverless 是纯 HTTP 驱动、无原生依赖,
 * 无条件引入的代价可以忽略 —— 用一点点包体换掉一整类"只在生产出现"的故障,很划算。
 */
export function getStore(): Store {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  cached = url ? new PgStore(neon(url) as unknown as SqlFn) : new FileStore();
  return cached;
}
