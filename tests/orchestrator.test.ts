/**
 * 主循环的确定性护栏。
 *
 * 这里不调用真实模型，只验证两条平台不变量：
 *  1. Piper 的 done 只是请求，缺任一交付事实都不能成功；
 *  2. 动态调度、门禁、预算和界面探查事件都能被 fold/UI 看见。
 */

import assert from "node:assert/strict";
import {
  completionIssues,
  mergeGeneratedFiles,
  qaTriageDispatch,
  qaTriageRoute,
} from "../src/lib/orchestrator";
import { buildQaTriage } from "../src/lib/roles";
import { foldEvents } from "../src/lib/fold";
import { toFeed } from "../src/lib/chatfeed";
import { changedFilePaths } from "../src/lib/file-diff";
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
  const expected = {
    "test-plan": "qa",
    requirements: "pm",
    visual: "designer",
    architecture: "architect",
    implementation: "engineer",
  } as const;
  for (const [cause, next] of Object.entries(expected)) {
    const triage = buildQaTriage({
      cause: cause as keyof typeof expected,
      reason: `${cause} 证据`,
      cases: ["失败用例"],
    });
    assert.equal(qaTriageDispatch(triage).next, next);
    assert.deepEqual(
      qaTriageRoute(triage).map((item) => item.next),
      next === "engineer" || next === "qa" ? [next] : [next, "engineer"],
    );
  }
  console.log("Orchestrator · ✓ Ida 分配包含上游修订→工程落地的完整确定性路线");
}

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
  assert.deepEqual(
    changedFilePaths(
      [
        { path: "/App.js", content: "old" },
        { path: "/keep.js", content: "same" },
        { path: "/removed.js", content: "gone" },
      ],
      [
        { path: "/App.js", content: "new" },
        { path: "/keep.js", content: "same" },
        { path: "/added.js", content: "new file" },
      ],
    ),
    ["/App.js", "/added.js", "/removed.js"],
  );
  console.log("Orchestrator · ✓ 本轮文件清单只报告真实新增、修改与删除");
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

{
  const event = (seq: number, value: RunEvent): Envelope<RunEvent> => ({
    runId: "feed-dedupe",
    seq,
    ts: 2000 + seq,
    event: value,
  });
  const usage = {
    promptTokens: 1,
    completionTokens: 1,
    reasoningTokens: 0,
    totalTokens: 2,
    costUsd: 0,
  };
  const state = foldEvents([
    event(0, { type: "run.started", prompt: "测试群聊", model: "m" }),
    event(1, { type: "node.started", node: "dispatch", role: "Piper", model: "m" }),
    event(2, {
      type: "node.finished",
      node: "dispatch",
      usage,
      durationMs: 10,
      prompt: "p",
      raw: "r",
    }),
    event(3, {
      type: "dispatch.decided",
      round: 1,
      next: "pm",
      reason: "PRD 尚未创建",
      brief: "把需求写成 PRD",
      budget: { dispatches: 1, maxDispatches: 20 },
    }),
    event(4, { type: "node.started", node: "accept", role: "Ida", model: "m" }),
    event(5, {
      type: "node.finished",
      node: "accept",
      usage,
      durationMs: 10,
      prompt: "p",
      raw: "r",
    }),
    event(6, {
      type: "accept.result",
      attempt: 1,
      accepted: true,
      dimensions: {
        functional: { ok: true, note: "功能完整" },
        usability: { ok: true, note: "路径清楚" },
        visual: { ok: true, note: "视觉匹配" },
      },
      issues: [],
      hardIssues: [],
      summary: "功能、体验与视觉均达到交付标准",
    }),
  ]);
  const feed = toFeed(state);
  const text = feed.map((item) => item.text).join("\n");
  assert.doesNotMatch(text, /派单判断完成|^做完了$/m, "过程占位不得单独留在群聊");
  assert.equal(feed.filter((item) => item.id.startsWith("dispatch")).length, 1);
  assert.match(text, /第 1 轮.*PRD 尚未创建/);
  assert.match(text, /验收通过,可以交付.*功能、体验与视觉均达到交付标准/);
  console.log("Orchestrator · ✓ 派单与验收只显示合并后的具体结果，不重复播报占位消息");
}

{
  const event = (seq: number, value: RunEvent): Envelope<RunEvent> => ({
    runId: "stopped-change",
    seq,
    ts: 3000 + seq,
    event: value,
  });
  const state = foldEvents([
    event(0, { type: "run.started", prompt: "测试失败收尾", model: "m" }),
    event(1, { type: "chat.user", turn: 1, text: "调整编辑功能" }),
    event(2, {
      type: "chat.done",
      turn: 1,
      summary: "本轮未完成；具体原因和下一步见上方 Piper 交接记录",
      changed: ["/App.js", "/components/Form.js"],
      outcome: "stopped",
    }),
  ]);
  const done = toFeed(state).find((item) => item.id === "u1-done");
  assert.equal(done?.tone, "warn");
  assert.equal(done?.tags, undefined, "失败收尾不应把文件树画成已完成改动");
  console.log("Orchestrator · ✓ 未完成的需求变更使用警示样式且不冒充成功文件清单");
}
