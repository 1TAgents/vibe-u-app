import assert from "node:assert/strict";
import { buildDeliverySummary } from "../src/lib/delivery-summary";
import { emptyState } from "../src/lib/fold";

{
  const state = emptyState();
  state.prd = {
    title: "待办清单",
    oneLiner: "管理每天要做的事",
    targetUsers: ["个人用户"],
    coreFeatures: [
      { name: "新增任务", description: "录入一条任务", priority: "P0" },
      { name: "删除任务", description: "移除不需要的任务", priority: "P0" },
    ],
    userFlow: ["新增", "完成"],
    nonGoals: [],
  };
  state.testCases = [
    { name: "新增后显示", covers: ["新增任务"], steps: [] },
    { name: "删除后消失", covers: ["删除任务"], steps: [] },
  ];
  state.buildHistory.push({
    seq: 1,
    at: 1,
    attempt: 1,
    ok: true,
    bytes: 204800,
    durationMs: 80,
    errors: [],
  });
  state.gates.push({
    seq: 2,
    at: 2,
    gate: "static-audit",
    trigger: "artifact:files",
    ok: true,
    blocking: true,
    facts: ["静态审计通过"],
    durationMs: 3,
  });
  state.qaHistory.push({
    seq: 3,
    at: 3,
    attempt: 1,
    passed: 2,
    failed: 0,
    durationMs: 120,
    cases: [
      { name: "新增后显示", covers: ["新增任务"], ok: true },
      { name: "删除后消失", covers: ["删除任务"], ok: true },
    ],
  });
  state.accepts.push({
    seq: 4,
    at: 4,
    attempt: 1,
    accepted: true,
    dimensions: {
      functional: { ok: true, note: "功能完整" },
      usability: { ok: true, note: "操作清楚" },
      visual: { ok: true, note: "视觉匹配" },
    },
    issues: [],
    hardIssues: [],
    summary: "可以交付",
  });

  const summary = buildDeliverySummary(state);
  assert.equal(summary.status, "ready");
  assert.equal(summary.p0Covered, 2);
  assert.equal(summary.p0Total, 2);
  assert.equal(summary.passedTests, 2);
  assert.equal(summary.passedEvidence, 4);
  assert.ok(summary.boundaries.every((item) => item.tone === "neutral"));
  console.log("Delivery summary · ✓ 承诺、测试与四类证据齐备时可交付");
}

{
  const state = emptyState();
  state.prd = {
    title: "读书笔记",
    oneLiner: "保存摘录",
    targetUsers: ["读者"],
    coreFeatures: [
      { name: "编辑摘录", description: "修改后仍然保留", priority: "P0" },
      { name: "删除摘录", description: "删除不需要的摘录", priority: "P0" },
    ],
    userFlow: ["打开", "编辑"],
    nonGoals: [],
  };
  state.testCases = [
    { name: "编辑后重新打开", covers: ["编辑摘录"], steps: [] },
  ];
  state.qaHistory.push({
    seq: 1,
    at: 1,
    attempt: 1,
    passed: 0,
    failed: 1,
    durationMs: 50,
    cases: [{ name: "编辑后重新打开", covers: ["编辑摘录"], ok: false, reason: "找不到内容输入框" }],
  });

  const summary = buildDeliverySummary(state);
  assert.equal(summary.status, "blocked");
  assert.equal(summary.p0Covered, 1);
  assert.ok(summary.boundaries.some((item) => item.text.includes("删除摘录")));
  assert.ok(summary.boundaries.some((item) => item.text.includes("找不到内容输入框")));
  console.log("Delivery summary · ✓ 未覆盖承诺和真实失败会进入已知边界");
}
