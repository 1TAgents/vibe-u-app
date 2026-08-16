/**
 * 主循环的确定性护栏。
 *
 * 这里不调用真实模型，只验证两条平台不变量：
 *  1. Piper 的 done 只是请求，缺任一交付事实都不能成功；
 *  2. 动态调度、门禁、预算和界面探查事件都能被 fold/UI 看见。
 */

import assert from "node:assert/strict";
import { completionIssues, mergeGeneratedFiles } from "../src/lib/orchestrator";
import { foldEvents } from "../src/lib/fold";
import { toFeed } from "../src/lib/chatfeed";
import type { Envelope, RunEvent } from "../src/lib/events";

const built = {
  ok: true as const,
  js: "console.log('ok')",
  css: "body{}",
  bytes: 24,
  durationMs: 1,
  warnings: [],
};

{
  const issues = completionIssues({ files: [] });
  assert.deepEqual(issues, [
    "PRD",
    "视觉方案",
    "架构设计",
    "代码",
    "最新代码构建",
    "验收用例",
    "功能验收通过",
    "交付验收",
  ]);

  assert.deepEqual(
    completionIssues({
      prd: {},
      visual: {},
      design: {},
      files: [{ path: "/App.js", content: "export default function App(){}" }],
      cases: [{ name: "可用", steps: [] }],
      built,
      html: "<div id=\"root\"></div>",
      qaPassed: true,
      accepted: true,
    }),
    [],
  );
  console.log("Orchestrator · ✓ done 只有在完整交付事实齐备时才允许通过");
}

{
  const merged = mergeGeneratedFiles(
    [
      { path: "/App.js", content: "old app" },
      { path: "/components/List.js", content: "keep me" },
    ],
    [{ path: "/App.js", content: "new app" }],
  );
  assert.deepEqual(merged, [
    { path: "/App.js", content: "new app" },
    { path: "/components/List.js", content: "keep me" },
  ]);
  console.log("Orchestrator · ✓ 局部修复按路径合并，不会误删未改文件");
}

{
  const event = (seq: number, value: RunEvent): Envelope<RunEvent> => ({
    runId: "audit-run",
    seq,
    ts: 1000 + seq,
    event: value,
  });
  const state = foldEvents([
    event(0, { type: "run.started", prompt: "测试", model: "m" }),
    event(1, {
      type: "dispatch.decided",
      round: 1,
      next: "pm",
      reason: "先定义范围",
      brief: "写 PRD",
      budget: { dispatches: 1, maxDispatches: 20 },
    }),
    event(2, {
      type: "gate.verdict",
      gate: "build",
      trigger: "artifact:files",
      ok: true,
      blocking: true,
      facts: ["构建通过"],
      durationMs: 3,
    }),
    event(3, {
      type: "build.result",
      attempt: 1,
      ok: true,
      bytes: 24,
      durationMs: 3,
      errors: [],
    }),
    event(4, {
      type: "budget.spent",
      dispatches: 1,
      maxDispatches: 20,
      sameRoleStreak: 1,
      tokens: 1234,
      costUsd: 0.0012,
    }),
    event(5, {
      type: "screen.probed",
      ok: true,
      layers: 2,
      clickables: ["新建"],
      inputs: ["标题"],
      regions: ["任务列表"],
      openedVia: "新建",
    }),
  ]);

  assert.equal(state.dispatches.length, 1);
  assert.equal(state.gates.length, 1);
  assert.equal(state.budgetHistory.at(-1)?.tokens, 1234);
  assert.equal(state.screenProbes.at(-1)?.layers, 2);
  const feed = toFeed(state).map((item) => item.text).join("\n");
  assert.match(feed, /Piper|第 1 轮|先定义范围/);
  assert.match(feed, /构建通过/);
  assert.match(feed, /界面探查完成/);
  console.log("Orchestrator · ✓ 调度、门禁、预算、界面探查可被 fold 与群聊投影");
}
