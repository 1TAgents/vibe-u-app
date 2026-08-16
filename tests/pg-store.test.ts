/**
 * Postgres 适配器的真实 SQL 验证。
 *
 * 这个测试存在的理由很具体:线上走 Postgres、本地走文件存储,
 * 意味着 PgStore 是一条**本地永远跑不到、上线必然跑到**的代码路径。
 * 这类路径的 bug 只会在生产暴露,是最贵的一种。
 *
 * 这里用 PGlite(编译成 WASM 的真 Postgres)在 Node 里起一个真实数据库,
 * 跑真的 CREATE TABLE / JSONB / ON CONFLICT / 排序 —— 而不是 mock 一个假的 sql 函数。
 * mock 只能验证"我调用了我以为的 SQL",验证不了"这段 SQL 在 Postgres 里真的成立"。
 *
 * 运行:npm run test:pg
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PgStore, type SqlFn } from "../src/lib/store";
import type { Envelope, RunEvent } from "../src/lib/events";
import { EMPTY_USAGE } from "../src/lib/events";

const db = new PGlite();

/** 把 neon 的 tagged-template 调用形态适配到 PGlite 的参数化查询 */
const sql: SqlFn = async (strings, ...values) => {
  let text = "";
  strings.forEach((s, i) => {
    text += s;
    if (i < values.length) text += `$${i + 1}`;
  });
  const res = await db.query(text, values);
  return res.rows as Record<string, unknown>[];
};

const store = new PgStore(sql);
const runId = "test-run-1";
let passed = 0;

function ok(label: string) {
  passed++;
  console.log(`  ✓ ${label}`);
}

async function main() {
  console.log("PgStore · 真实 Postgres(PGlite)");

  /* --- runs --- */
  const now = Date.now();
  await store.createRun({
    id: runId,
    prompt: "做一个待办清单",
    model: "deepseek-v4-flash",
    label: null,
    status: "running",
    totals: { ...EMPTY_USAGE },
    createdAt: now,
    updatedAt: now,
  });
  const created = await store.getRun(runId);
  assert.equal(created?.prompt, "做一个待办清单");
  assert.equal(created?.model, "deepseek-v4-flash");
  ok("createRun / getRun 往返(含中文)");

  // BIGINT 在多数驱动里回来是 string,rowToRun 必须转成 number —— 这正是要验的
  assert.equal(typeof created?.createdAt, "number");
  assert.equal(created?.createdAt, now);
  ok("BIGINT 时间戳回读为 number 且不失真");

  await store.updateRun(runId, {
    status: "succeeded",
    totals: { ...EMPTY_USAGE, totalTokens: 29386, costUsd: 0.00771 },
  });
  const updated = await store.getRun(runId);
  assert.equal(updated?.status, "succeeded");
  assert.equal(updated?.totals.totalTokens, 29386);
  assert.equal(updated?.totals.costUsd, 0.00771);
  ok("updateRun 写回 JSONB totals 且浮点不失真");

  assert.equal(await store.getRun("不存在的-run"), null);
  ok("getRun 未命中返回 null");

  await store.createRun({
    id: "test-run-2",
    prompt: "第二个",
    model: "glm-5.2",
    label: "race",
    status: "running",
    totals: { ...EMPTY_USAGE },
    createdAt: now + 1000,
    updatedAt: now + 1000,
  });
  const list = await store.listRuns(10);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "test-run-2", "应按 created_at 倒序");
  assert.equal(list[0].label, "race");
  ok("listRuns 倒序 + label 可空字段");

  assert.equal((await store.listRuns(1)).length, 1);
  ok("listRuns 的 LIMIT 参数化生效");

  /* --- events --- */
  const events: Envelope<RunEvent>[] = [
    {
      runId,
      seq: 0,
      ts: now,
      event: { type: "run.started", prompt: "做一个待办清单", model: "deepseek-v4-flash" },
    },
    {
      runId,
      seq: 1,
      ts: now + 10,
      event: { type: "node.started", node: "pm", role: "Emma · 产品经理", model: "deepseek-v4-flash" },
    },
    {
      runId,
      seq: 2,
      ts: now + 20,
      event: { type: "node.reasoning.delta", node: "pm", text: '含"双引号"和\n换行的思考' },
    },
  ];
  await store.appendEvents(runId, events);
  const read = await store.readEvents(runId);
  assert.equal(read.length, 3);
  assert.equal(read[0].seq, 0);
  assert.equal(read[2].seq, 2, "应按 seq 升序");
  assert.deepEqual(read[2].event, events[2].event);
  ok("appendEvents / readEvents 往返(含引号与换行)");

  assert.equal(typeof read[0].ts, "number");
  ok("事件时间戳回读为 number");

  // 重放同一批必须幂等 —— SSE 断线重连会真的重复投递
  await store.appendEvents(runId, events);
  assert.equal((await store.readEvents(runId)).length, 3);
  ok("重复 appendEvents 幂等(ON CONFLICT DO NOTHING)");

  assert.deepEqual(await store.readEvents("不存在的-run"), []);
  ok("readEvents 未命中返回空数组");

  /* --- compiled app bundles（候选与公开版本） --- */
  assert.equal(await store.getAppBundle(runId, "published"), null);
  const firstBundle = {
    js: "console.log('v1')",
    css: "body{color:#111}",
    bytes: 36,
    updatedAt: now + 30,
  };
  await store.saveAppBundle(runId, firstBundle);
  assert.deepEqual(await store.getAppBundle(runId, "candidate"), firstBundle);
  assert.equal(await store.getAppBundle(runId, "published"), null);
  ok("候选构建不会提前暴露为公开版本");

  await store.publishAppBundle(runId);
  assert.deepEqual(await store.getAppBundle(runId, "published"), firstBundle);
  ok("浏览器校验后可原子发布候选构建");

  const secondBundle = {
    js: "console.log('v2')",
    css: "body{color:#222}",
    bytes: 36,
    updatedAt: now + 40,
  };
  await store.saveAppBundle(runId, secondBundle);
  assert.deepEqual(await store.getAppBundle(runId, "candidate"), secondBundle);
  assert.deepEqual(
    await store.getAppBundle(runId, "published"),
    firstBundle,
    "新一轮迭代未通过校验前，公开链接必须继续服务上一版",
  );
  ok("候选迭代与已发布应用互不覆盖");

  /* --- app rows(生成物的数据) --- */
  const book = await store.appInsert(runId, "books", { title: "置身事内", author: "兰小欢" });
  assert.ok(book.id);
  assert.equal(book.title, "置身事内");
  assert.equal(typeof book.createdAt, "number");
  ok("appInsert 自动补 id 与 createdAt");

  await store.appInsert(runId, "books", { title: "第二本", author: "某人" });
  const books = await store.appList(runId, "books");
  assert.equal(books.length, 2);
  assert.equal(books[0].title, "置身事内", "应按插入顺序返回");
  ok("appList 按插入顺序返回");

  /*
   * 回归护栏:同一毫秒内连续插入。
   * 这正是最初 ORDER BY created_at 翻车的场景 —— 时间戳完全相同时
   * Postgres 对并列行不保证任何顺序,列表会随机乱序;
   * 而文件存储是数组追加、天然保序,所以这个分歧只会在线上暴露。
   */
  const burst = "burst";
  const titles = ["甲", "乙", "丙", "丙丁", "戊"];
  // 冻结 Date.now,保证 5 条落在同一毫秒 —— 否则负载高时每次插入都可能跨毫秒,
  // 时间戳全不相同,这个「同毫秒保序」的回归护栏会因场景没成型而误报(假失败)。
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    for (const t of titles) await store.appInsert(runId, burst, { t });
  } finally {
    Date.now = realNow;
  }
  const got = (await store.appList(runId, burst)).map((r) => r.t);
  assert.deepEqual(got, titles, "同毫秒批量插入也必须保持插入顺序");
  const stamps = new Set(
    (await store.appList(runId, burst)).map((r) => r.createdAt as number),
  );
  assert.ok(stamps.size < titles.length, "本用例需要至少两条记录时间戳相同才有意义");
  ok(`同一毫秒连续插入 ${titles.length} 条仍严格保序(实测 ${stamps.size} 个不同时间戳)`);

  // 按 runId 隔离:另一个 run 的同名 collection 必须互不可见
  await store.appInsert("test-run-2", "books", { title: "别的 run 的书" });
  assert.equal((await store.appList(runId, "books")).length, 2);
  assert.equal((await store.appList("test-run-2", "books")).length, 1);
  ok("生成物数据按 runId 隔离");

  const patched = await store.appUpdate(runId, "books", book.id, { author: "兰小欢(改)" });
  assert.equal(patched?.author, "兰小欢(改)");
  assert.equal(patched?.title, "置身事内", "局部更新不能丢掉未提及的字段");
  assert.equal(patched?.id, book.id);
  assert.equal(patched?.createdAt, book.createdAt);
  ok("appUpdate 局部合并且保留 id / createdAt");

  assert.equal(await store.appUpdate(runId, "books", "不存在", { x: 1 }), null);
  ok("appUpdate 未命中返回 null");

  await store.appRemove(runId, "books", book.id);
  assert.equal((await store.appList(runId, "books")).length, 1);
  ok("appRemove 生效");

  assert.deepEqual(await store.appList(runId, "空集合"), []);
  ok("空集合返回空数组");

  console.log(`\n全部通过:${passed} 项`);
}

main().catch((e) => {
  console.error("\n✗ 失败:", e);
  process.exit(1);
});
