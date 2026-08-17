/**
 * 结构化产物解析修正(node.parse_retry)的确定性单测。
 *
 * 覆盖四层:
 *   1. events —— node.parse_retry 事件被 fold 正确消费;
 *   2. fold  —— run 级 parseRetries 聚合、节点级修正序数、被拒绝尝试的失败留痕;
 *   3. chatfeed —— UI 时间线显示「结构化产物修正第 N 次」;
 *   4. runner —— structureChanged 纯函数把 parseRetries>0 纳入结构改进判定
 *                (runner 直接用这个函数,避免观测口径漂移)。
 */

import assert from "node:assert/strict";
import { applyEvent, emptyState, structureChanged } from "../src/lib/fold";
import { toFeed } from "../src/lib/chatfeed";
import type { Envelope, RunEvent } from "../src/lib/events";

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: 0 };

const state = emptyState();
let seq = 0;
function push(event: RunEvent) {
  const env: Envelope<RunEvent> = { runId: "parse-retry-test", seq: seq++, ts: Date.now(), event };
  applyEvent(state, env);
}
function nodeDone(node: "pm" | "designer", role: string) {
  push({ type: "node.started", node, role, model: "deepseek-v4-flash" });
  push({
    type: "node.finished",
    node,
    usage: { ...ZERO_USAGE },
    durationMs: 10,
    prompt: "p",
    raw: "{}",
  });
}

// 1) 首次解析修正:run 聚合 +1、节点序数 1、被拒绝尝试失败留痕
nodeDone("designer", "Luna");
push({ type: "node.parse_retry", node: "designer", attempt: 1, reason: "JSON 缺左中括号" });
assert.equal(state.parseRetries, 1, "run 级聚合应 +1");
const first = state.timeline.find((n) => n.id === "designer");
assert.equal(first?.phase, "failed", "被解析打回的尝试应标记失败");
assert.equal(first?.parseRetries, 1, "节点序数应从 1 起算");
assert.match(first?.error ?? "", /结构化产物未通过解析\(第 1 次\)/);
assert.match(first?.error ?? "", /JSON 缺左中括号/);
console.log("ParseRetry · ✓ 首次解析修正:run 聚合、节点序数、失败留痕");

// 2) 同节点第二次解析修正:序数递增为 2,聚合为 2
nodeDone("designer", "Luna");
push({ type: "node.parse_retry", node: "designer", attempt: 2, reason: "仍缺字段" });
assert.equal(state.parseRetries, 2, "run 级聚合应累计到 2");
const designerEntries = state.timeline.filter((n) => n.id === "designer");
assert.equal(designerEntries.length, 2);
assert.equal(designerEntries[1]?.parseRetries, 2, "同节点第二次修正序数应为 2");
assert.equal(designerEntries[0]?.parseRetries, 1, "第一次尝试的序数不应被覆盖");
console.log("ParseRetry · ✓ 同节点第二次解析修正:序数递增为 2");

// 3) 不同节点各自从 1 起算,互不串扰
nodeDone("pm", "Ida");
push({ type: "node.parse_retry", node: "pm", attempt: 1, reason: "coreFeatures 字段类型错误" });
assert.equal(state.parseRetries, 3, "不同节点的修正都计入 run 级聚合");
const pmEntry = state.timeline.find((n) => n.id === "pm");
assert.equal(pmEntry?.parseRetries, 1, "不同节点各自从 1 起算");
console.log("ParseRetry · ✓ 不同节点解析修正独立计数");

// 4) UI 时间线显示「结构化产物修正第 N 次」
const feedText = toFeed(state)
  .map((i) => i.text)
  .join("\n");
assert.match(feedText, /视觉方案定好了\(结构化产物修正第 1 次\)/, "修正提示应跟在角色发言之后");
assert.match(feedText, /结构化产物修正第 2 次/, "时间线应显示第二次修正");
assert.match(feedText, /结构化产物修正第 1 次/, "时间线应显示第一次修正");
console.log("ParseRetry · ✓ 群聊时间线显示「结构化产物修正第 N 次」");

// 5) structureChanged(纯函数,runner 复用):parseRetries>0 必须纳入结构改进
assert.equal(structureChanged(state), true, "有解析修正必须判定为结构改进");
const clean = emptyState();
assert.equal(structureChanged(clean), false, "无任何结构改动时为 false");
const onlyParse = emptyState();
applyEvent(onlyParse, {
  runId: "t",
  seq: 0,
  ts: Date.now(),
  event: { type: "node.started", node: "designer", role: "Luna", model: "m" },
});
applyEvent(onlyParse, {
  runId: "t",
  seq: 1,
  ts: Date.now(),
  event: { type: "node.parse_retry", node: "designer", attempt: 1, reason: "x" },
});
assert.equal(structureChanged(onlyParse), true, "只触发解析修正也应判定为结构改进");
console.log("ParseRetry · ✓ structureChanged 纳入解析修正(单靠它也能判定)");

// 6) 旧事件兼容:历史 run 持久化的 artifact.rejected 必须仍可回放并计入 parseRetries
const legacy = emptyState();
pushWith(
  legacy,
  { type: "node.started", node: "designer", role: "Luna", model: "deepseek-v4-flash" },
  0,
);
pushWith(
  legacy,
  { type: "artifact.rejected", node: "designer", attempt: 1, reason: "旧事件:JSON 不合法" },
  1,
);
assert.equal(legacy.parseRetries, 1, "旧事件必须计入 parseRetries");
const legacyEntry = legacy.timeline.find((n) => n.id === "designer");
assert.equal(legacyEntry?.phase, "failed", "旧事件也要把被拒绝的尝试标红");
assert.match(legacyEntry?.error ?? "", /JSON 不合法/, "旧事件也要带上解析错误");
assert.equal(structureChanged(legacy), true, "旧事件触发的解析修正也要判定为结构改进");
console.log("ParseRetry · ✓ 旧事件 artifact.rejected 仍可回放并计入 parseRetries");

function pushWith(s: ReturnType<typeof emptyState>, event: RunEvent, sq: number) {
  applyEvent(s, { runId: "legacy", seq: sq, ts: Date.now(), event });
}
