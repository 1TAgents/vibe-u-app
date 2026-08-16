/**
 * SSE 传输层的确定性测试。
 *
 * 覆盖两个此前缺失的结构保证:
 *   1. 异常路径要把 run 从「running」推到终态 —— 业务异常 → failed,
 *      不再让失败运行在历史里永远显示 running。
 *   2. 取消可贯通工作:外部 signal(req.signal)或客户端断开(stream cancel)
 *      都会打断正在跑的角色,不再继续启动后续角色、不再烧 token,run 收敛为 aborted。
 *
 * 使用真实 FileStore(getStore 默认路径),验证落库后的 status,而不是 mock。
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { EMPTY_USAGE, type Envelope, type RunEvent } from "../src/lib/events";
import { foldEvents } from "../src/lib/fold";
import { sseResponse } from "../src/lib/sse";
import { getStore } from "../src/lib/store";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RUNS_DIR = path.join(process.cwd(), ".data", "runs");

/** 把 SSE 文本按帧拆出来;半帧留到下一次 */
function parseFrames(buf: string, events: Envelope<RunEvent>[]) {
  const frames = buf.split("\n\n");
  const rest = frames.pop() ?? "";
  for (const frame of frames) {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload) as Envelope<RunEvent>);
    } catch {
      /* 半帧 */
    }
  }
  return rest;
}

async function createRun(id: string) {
  const now = Date.now();
  await getStore().createRun({
    id,
    prompt: "测试",
    model: "deepseek-v4-flash",
    label: null,
    status: "running",
    totals: { ...EMPTY_USAGE },
    createdAt: now,
    updatedAt: now,
  });
}

async function statusOf(id: string): Promise<string | undefined> {
  return (await getStore().getRun(id))?.status;
}

/** 轮询等待 run 收敛到期望终态,避免 catch/finally 的异步尾巴没跑完 */
async function waitStatus(id: string, expected: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await statusOf(id)) === expected) return;
    await sleep(10);
  }
  assert.equal(await statusOf(id), expected, `run ${id} 应在超时前收敛为 ${expected}`);
}

async function cleanup(...ids: string[]) {
  for (const id of ids) await rm(path.join(RUNS_DIR, id), { recursive: true, force: true });
}

(async () => {
  const decoder = new TextDecoder();

  // ---- 1. 业务异常 → run 收敛为 failed,不再滞留 running ----
  {
    await createRun("sse-fail-test");
    const res = sseResponse("sse-fail-test", 0, async () => {
      throw new Error("业务异常:连续 3 次构建未通过");
    }, EMPTY_USAGE);
    const reader = res.body!.getReader();
    const events: Envelope<RunEvent>[] = [];
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = parseFrames(buf, events);
    }
    const abortedEnv = events.find((e) => e.event.type === "run.aborted");
    assert.ok(abortedEnv, "业务异常应发 run.aborted");
    const aborted = abortedEnv.event;
    assert.ok(aborted.type === "run.aborted");
    assert.match(aborted.reason, /构建未通过/);
    await waitStatus("sse-fail-test", "failed");
    assert.ok(!events.some((e) => e.event.type === "run.finished"), "业务异常不是正常完成,不应发 run.finished");
    console.log("SSE · ✓ 业务异常 → run 收敛为 failed(不再滞留 running)");
  }

  // ---- 2. 外部 signal(req.signal)取消 → 打断角色,不启动后续角色,run 收敛为 aborted ----
  {
    await createRun("sse-abort-test");
    const ac = new AbortController();
    let roleFinished = false;
    const res = sseResponse(
      "sse-abort-test",
      0,
      async (sink, signal) => {
        sink.emit({ type: "node.started", node: "engineer", role: "工程师", model: "m" });
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => {
            roleFinished = true;
            resolve();
          }, 5000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(signal.reason instanceof Error ? signal.reason : new Error("cancelled"));
            },
            { once: true },
          );
        });
        // 取消前不该到达这里
        sink.emit({ type: "node.finished", node: "engineer", usage: EMPTY_USAGE, durationMs: 1, prompt: "", raw: "" });
        sink.emit({ type: "node.started", node: "qa", role: "测试", model: "m" });
      },
      EMPTY_USAGE,
      ac.signal,
    );
    const reader = res.body!.getReader();
    const events: Envelope<RunEvent>[] = [];
    let buf = "";
    const reading = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        buf = parseFrames(buf, events);
      }
    })();

    await sleep(50);
    ac.abort(new Error("user-cancelled"));
    await reading;
    await waitStatus("sse-abort-test", "aborted");

    assert.equal(roleFinished, false, "取消后角色不应继续跑完");
    assert.ok(events.some((e) => e.event.type === "node.started" && e.event.node === "engineer"), "已开始的角色可见");
    assert.ok(!events.some((e) => e.event.type === "node.finished"), "角色不应产出 finished");
    assert.ok(!events.some((e) => e.event.type === "node.started" && e.event.node === "qa"), "取消后不应启动后续角色");
    assert.ok(events.some((e) => e.event.type === "run.aborted"), "取消应发 run.aborted");
    console.log("SSE · ✓ req.signal 取消:后续角色不再启动,run 收敛为 aborted");
  }

  // ---- 3. 客户端断开(stream cancel)→ 打断角色,run 收敛为 aborted ----
  {
    await createRun("sse-cancel-test");
    let roleFinished = false;
    const res = sseResponse(
      "sse-cancel-test",
      0,
      async (sink, signal) => {
        sink.emit({ type: "node.started", node: "engineer", role: "工程师", model: "m" });
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => {
            roleFinished = true;
            resolve();
          }, 5000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(signal.reason instanceof Error ? signal.reason : new Error("cancelled"));
            },
            { once: true },
          );
        });
        sink.emit({ type: "node.finished", node: "engineer", usage: EMPTY_USAGE, durationMs: 1, prompt: "", raw: "" });
      },
      EMPTY_USAGE,
    );
    const reader = res.body!.getReader();
    const events: Envelope<RunEvent>[] = [];
    let buf = "";
    const reading = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        buf = parseFrames(buf, events);
      }
    })();

    await sleep(50);
    await reader.cancel("client-disconnect");
    await reading;
    await waitStatus("sse-cancel-test", "aborted");

    assert.equal(roleFinished, false, "客户端断开后角色不应继续跑完");
    assert.ok(!events.some((e) => e.event.type === "node.finished"), "角色不应产出 finished");
    // 客户端已断开,SSE 事件送不到;但 run.aborted 必须落库,回放能看到为什么停
    const persisted = await getStore().readEvents("sse-cancel-test");
    assert.ok(
      persisted.some((e) => e.event.type === "run.aborted"),
      "客户端断开后 run.aborted 应落库(回放可审计)",
    );
    console.log("SSE · ✓ 客户端断开(stream cancel)→ 打断角色,run 收敛为 aborted(事件落库)");
  }

  // ---- 4. 硬门拒绝后显式收尾:/abort 把 running+verify.started 推到 aborted 终态,幂等 ----
  {
    await createRun("sse-abort-settle-test");
    // 模拟:跑完 QA 发了 verify.started 就停在那儿(runner 硬门判死,不再汇报 verify)
    const store = getStore();
    await store.appendEvents("sse-abort-settle-test", [
      { runId: "sse-abort-settle-test", seq: 0, ts: Date.now(), event: { type: "run.started", prompt: "x", model: "m" } },
      { runId: "sse-abort-settle-test", seq: 1, ts: Date.now(), event: { type: "verify.started", attempt: 1 } },
    ]);

    // 直接调用路由:POST /api/run/[runId]/abort
    const { POST } = await import("../src/app/api/run/[runId]/abort/route");
    const ctx = { params: Promise.resolve({ runId: "sse-abort-settle-test" }) };
    const res = await POST(
      new Request("http://localhost/api/run/sse-abort-settle-test/abort", {
        method: "POST",
        body: JSON.stringify({ reason: "验证台硬门拒绝:QA 未覆盖难点语义" }),
      }),
      ctx as never,
    );
    const data = (await res.json()) as { ok: boolean; idempotent: boolean; status: string };
    assert.equal(data.ok, true);
    assert.equal(data.idempotent, false);
    assert.equal(data.status, "aborted");
    await waitStatus("sse-abort-settle-test", "aborted");

    // 事件流里必须有一条 run.aborted(回放可审计),且 fold 收敛为 aborted
    const persisted = await store.readEvents("sse-abort-settle-test");
    assert.ok(
      persisted.some((e) => e.event.type === "run.aborted"),
      "run.aborted 必须落库,回放能看到为什么停",
    );
    const settled = foldEvents(persisted);
    assert.equal(settled.aborted, "验证台硬门拒绝:QA 未覆盖难点语义");

    // 幂等:已到 aborted 的 run 再调 /abort 不应重复追加事件
    const again = await POST(
      new Request("http://localhost/api/run/sse-abort-settle-test/abort", {
        method: "POST",
        body: JSON.stringify({ reason: "再来一次" }),
      }),
      ctx as never,
    );
    const data2 = (await again.json()) as { ok: boolean; idempotent: boolean };
    assert.equal(data2.idempotent, true);
    const persisted2 = await store.readEvents("sse-abort-settle-test");
    assert.equal(
      persisted2.filter((e) => e.event.type === "run.aborted").length,
      1,
      "幂等:已终止的 run 不应重复追加 run.aborted",
    );
    console.log("SSE · ✓ 硬门拒绝后 /abort 显式收尾:running+verify.started → aborted(幂等)");
  }

  await cleanup("sse-fail-test", "sse-abort-test", "sse-cancel-test", "sse-abort-settle-test");
  console.log("SSE 终止态与取消 · 全部通过");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
