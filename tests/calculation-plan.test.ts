import assert from "node:assert/strict";
import { mortgageExpectationIssues } from "../src/lib/stressCoverage";

const base = {
  name: "输入完整参数计算月供与总利息",
  covers: ["月供计算", "总利息计算"],
  steps: [
    { action: "fill" as const, target: "房屋总价", value: "3000000" },
    { action: "fill" as const, target: "首付比例", value: "30" },
    { action: "fill" as const, target: "年利率", value: "3.85" },
    { action: "fill" as const, target: "贷款年限", value: "30" },
  ],
};

const wrong = mortgageExpectationIssues([
  {
    ...base,
    steps: [
      ...base.steps,
      { action: "expectTextWithin", target: "测算结果", text: "¥11,113.15" },
      { action: "expectTextWithin", target: "测算结果", text: "¥1,000,730.00" },
    ],
  },
]);
assert.equal(wrong.length, 2);
assert.ok(wrong.every((issue) => issue.startsWith("房贷算术预期不一致")));

const correct = mortgageExpectationIssues([
  {
    ...base,
    steps: [
      ...base.steps,
      { action: "expectTextWithin", target: "测算结果", text: "¥9,844.97" },
      { action: "expectTextWithin", target: "测算结果", text: "¥1,444,190.24" },
    ],
  },
]);
assert.deepEqual(correct, []);

console.log("Calculation plan · ✓ 错误房贷期望被拒，独立复算结果通过");
