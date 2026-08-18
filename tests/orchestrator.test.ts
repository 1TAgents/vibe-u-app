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
  coverageMissingFromFacts,
  deliveryRepairDispatch,
  enforceQaTriageEscalation,
  mergeGeneratedFiles,
  qaCoverageSignature,
  qaTriageEvidence,
  qaTriageDispatch,
  qaTriageRoute,
} from "../src/lib/orchestrator";
import { buildQaTriage, pmPrompt, qaPrompt, qaTriagePrompt } from "../src/lib/roles";
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
  assert.equal(
    qaCoverageSignature([
      { name: "连续打卡", covers: ["连续天数", "每日打卡"], steps: [] },
      { name: "隔天重置", covers: ["连续天数"], steps: [] },
    ]),
    "每日打卡|连续天数",
  );
  assert.equal(
    qaCoverageSignature(
      [{ name: "被改写的用例", covers: ["错误标签"], steps: [] }],
      ["每日打卡", "连续天数"],
    ),
    "每日打卡|连续天数",
    "存在 PRD P0 清单时，签名不得随 Tess 改写 covers 而漂移",
  );
  assert.throws(
    () => enforceQaTriageEscalation({ cause: "test-plan" as const }, 2),
    /不能再次选择 test-plan/,
  );
  assert.deepEqual(
    enforceQaTriageEscalation({ cause: "implementation" as const }, 2),
    { cause: "implementation" },
  );
  console.log("Orchestrator · ✓ 同一 P0 场景两次 QA 重写后强制升级责任层");
}

{
  assert.deepEqual(
    coverageMissingFromFacts([
      "缺覆盖:低库存零边界闭环",
      "缺覆盖:低库存零边界闭环",
      "测试目标有误",
    ]),
    ["低库存零边界闭环"],
  );
  console.log("Orchestrator · ✓ 场景覆盖缺口以结构化参数回喂 QA");
}

{
  const evidence = qaTriageEvidence(
    ["找不到区域「休息倒计时 5:00」"],
    {
      verdicts: [{
        gate: "test-plan",
        name: "测试计划体检",
        ok: false,
        blocking: false,
        facts: ["target「休息倒计时 5:00」不在源码或真实界面"],
        durationMs: 0,
      }],
    },
  );
  assert.equal(evidence.length, 2);
  assert.match(evidence[1], /^测试计划预检警告：/);
  console.log("Orchestrator · ✓ QA 归因保留命中同一目标的计划预检证据");
}

{
  const prompt = pmPrompt("做一个番茄钟");
  assert.match(prompt.system, /自动转换条件/);
  assert.match(prompt.system, /自然完成才计数，手动跳过不计数/);
  console.log("Orchestrator · ✓ 计时与状态机需求必须定义转换和计数语义");
}

{
  const prompt = qaPrompt(
    {
      title: "会议预订",
      oneLiner: "预订会议室",
      targetUsers: ["员工"],
      coreFeatures: [{ name: "选择时段", description: "使用下拉框选择", priority: "P0" }],
      userFlow: ["选择时间"],
      nonGoals: [],
    },
    [{ path: "/App.js", content: "<select aria-label=\"开始时间\"><option>17:30</option></select>" }],
  );
  assert.match(prompt.system, /原生下拉框\(select\)也使用 fill/);
  assert.match(prompt.system, /"target":"开始时间","value":"17:30"/);
  assert.match(prompt.system, /加减步进器不是输入框/);
  assert.match(prompt.system, /aria-label 是定位名称，不保证整句作为可见文字渲染/);
  assert.match(prompt.system, /计算结果、统计卡片等只读金额绝不是输入框/);
  assert.match(prompt.system, /不能仅因为“无效”就假设一定存在 aria-invalid/);
  console.log("Orchestrator · ✓ QA 对原生下拉框使用 fill 选择而不是点击 option");
}

{
  const prompt = qaPrompt(
    {
      title: "报销",
      oneLiner: "记录费用",
      targetUsers: ["员工"],
      coreFeatures: [{ name: "分类筛选", description: "按分类看记录", priority: "P0" }],
      userFlow: ["点击分类"],
      nonGoals: [],
    },
    [{ path: "/App.js", content: "<button>餐饮</button>" }],
    undefined,
    undefined,
    { clickables: ["餐饮"], inputs: [], regions: [], headings: ["报销"] },
  );
  assert.match(prompt.user, /本版用例中禁止出现任何 `\*Within` 动作/);
  assert.match(prompt.user, /筛选按钮「餐饮\/办公」/);
  console.log("Orchestrator · ✓ QA 不会把筛选按钮误当成内容区域");
}

{
  const repair = deliveryRepairDispatch([
    "页面没有任何标题元素(h1/h2/h3),信息层级不清楚",
  ]);
  assert.equal(repair.next, "engineer");
  assert.match(repair.reason, /当前实现缺陷/);
  assert.match(repair.brief, /修复代码/);
  console.log("Orchestrator · ✓ 交付 DOM/CSS 硬伤直接交给工程师修当前实现");
}

{
  const prompt = qaTriagePrompt({
    prd: {
      title: "会议室预订",
      oneLiner: "预订会议室",
      targetUsers: ["员工"],
      coreFeatures: [{ name: "快速预订", description: "点击空闲时段预订", priority: "P0" }],
      userFlow: ["选择会议室"],
      nonGoals: ["不提供会议室管理"],
    },
    design: { dataModel: [], pages: [], notes: "会议室是产品基础资源" },
    failures: ["找不到可点击的「会议室A 08:00-08:30 空闲」"],
    screen: { clickables: ["我的预订"], inputs: [], regions: ["我的预订"] },
    cases: [{
      name: "连续两天预订",
      covers: ["快速预订"],
      steps: [{ action: "expectAttribute", attr: "aria-pressed", value: "false" }],
    }],
    testPlanRewriteCount: 1,
  });
  assert.match(prompt.system, /漏了静态配置或种子数据/);
  assert.match(prompt.system, /报销单、训练记录等本来就由用户创建/);
  assert.match(prompt.system, /绝不能用缺种子数据解释后续失败/);
  assert.match(prompt.user, /平台界面探查/);
  assert.match(prompt.user, /我的预订/);
  assert.match(prompt.system, /P0 功能时，这条业务场景必须保留/);
  assert.match(prompt.system, /aria-pressed[\s\S]*不自动等于业务结果/);
  assert.match(prompt.user, /当前验收计划/);
  assert.match(prompt.system, /连续退回 Tess 1 次/);
  console.log("Orchestrator · ✓ QA 归因能看到真实空页面并识别缺失基础资源");
}

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
  const qaRetry = buildQaTriage({
    cause: "test-plan",
    reason: "不要断言 PRD 未要求的 aria-invalid",
    cases: ["找不到带 aria-invalid 的输入框"],
  });
  assert.match(
    qaTriageDispatch(qaRetry).brief,
    /不要断言 PRD 未要求的 aria-invalid/,
    "QA 返工 brief 必须携带 Ida 的具体归因，不能只给通用重写指令",
  );
  assert.match(qaTriageDispatch(qaRetry).brief, /P0 的业务场景必须保留/);
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
    runId: "triage-feed",
    seq,
    ts: 2500 + seq,
    event: value,
  });
  const state = foldEvents([
    event(0, { type: "run.started", prompt: "测试 QA 归因", model: "m" }),
    event(1, {
      type: "qa.triage",
      attempt: 1,
      triage: {
        cause: "test-plan",
        prdImpact: false,
        visualImpact: false,
        designImpact: false,
        reason: "用例断言超出 PRD",
        cases: ["空内容不能添加"],
        assignee: "tess",
        route: ["qa"],
      },
    }),
  ]);
  const triage = toFeed(state).find((item) => item.id === "t0");
  assert.equal(triage?.name, "Piper");
  assert.equal(triage?.title, "项目经理");
  assert.match(triage?.text ?? "", /退回 Tess 重写用例/);
  console.log("Orchestrator · ✓ QA 归因由 Piper 投影，历史 qa.triage 事件不会让工作区崩溃");
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
