import assert from "node:assert/strict";
import {
  mortgageExpectationIssues,
  normalizeMortgageExpectations,
} from "../src/lib/stressCoverage";

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

const displayInTenThousands = mortgageExpectationIssues([
  {
    name: "零利率一年期按万元展示",
    covers: ["月供计算", "总利息计算"],
    steps: [
      { action: "fill", target: "房屋总价", value: "100" },
      { action: "fill", target: "首付比例", value: "0" },
      { action: "fill", target: "年利率", value: "0" },
      { action: "fill", target: "贷款年限", value: "1" },
      { action: "expectTextWithin", target: "计算结果", text: "8.33" },
      { action: "expectTextWithin", target: "计算结果", text: "0.00" },
      { action: "expectTextWithin", target: "计算结果", text: "100.00 万元" },
    ],
  },
]);
assert.deepEqual(displayInTenThousands, [], "结果卡片里的纯数值/万元断言也是金额证据");

const normalized = normalizeMortgageExpectations([
  {
    name: "模型把房贷结果算错",
    covers: ["月供计算", "总利息计算", "结果展示"],
    steps: [
      { action: "fill", target: "房屋总价", value: "2000000" },
      { action: "fill", target: "首付比例", value: "0" },
      { action: "fill", target: "年利率", value: "4.9" },
      { action: "fill", target: "贷款年限", value: "30" },
      { action: "click", target: "计算月供" },
      { action: "expectTextWithin", target: "计算结果", text: "¥10,615.58" },
      { action: "expectTextWithin", target: "计算结果", text: "¥616,560.88" },
      { action: "expectTextWithin", target: "计算结果", text: "¥2,000,000.00" },
    ],
  },
]);
assert.equal(normalized[0].steps[5].action, "expectTextWithin");
assert.equal("text" in normalized[0].steps[5] && normalized[0].steps[5].text, "¥10,614.53");
assert.equal("text" in normalized[0].steps[6] && normalized[0].steps[6].text, "¥1,821,232.39");
assert.equal("text" in normalized[0].steps[7] && normalized[0].steps[7].text, "¥2,000,000.00");
assert.deepEqual(mortgageExpectationIssues(normalized), []);

const wanMixedUnits = normalizeMortgageExpectations([{
  name: "输入总价300万、首付30%、贷款年利率4.2%、贷款年限30年",
  covers: ["月供计算", "总利息计算"],
  steps: [
    { action: "fill", target: "房屋总价", value: "300" },
    { action: "fill", target: "首付比例", value: "30" },
    { action: "fill", target: "贷款年利率", value: "4.2" },
    { action: "fill", target: "贷款年限", value: "30" },
    { action: "click", target: "计算月供" },
    { action: "expectText", text: "10,252.60" },
    { action: "expectText", text: "69.09" },
    { action: "expectText", text: "210.00" },
  ],
}]);
assert.equal(wanMixedUnits[0].steps[5].action, "expectText");
assert.equal((wanMixedUnits[0].steps[5] as { text: string }).text, "10,269.36");
assert.equal((wanMixedUnits[0].steps[6] as { text: string }).text, "159.70");
assert.equal((wanMixedUnits[0].steps[7] as { text: string }).text, "210.00");
assert.deepEqual(mortgageExpectationIssues(wanMixedUnits), []);

const numericRegions = normalizeMortgageExpectations([{
  name: "输入总价、首付比例、利率和年限计算月供和总利息",
  covers: ["月供", "总利息"],
  steps: [
    { action: "fill", target: "房屋总价（元）", value: "3000000" },
    { action: "fill", target: "首付比例（%）", value: "30" },
    { action: "fill", target: "年利率（%）", value: "3.85" },
    { action: "fill", target: "贷款年限（年）", value: "30" },
    { action: "click", target: "开始计算" },
    { action: "expectNumberWithin", target: "每月月供 金额", value: "11209.10" },
    { action: "expectNumberWithin", target: "总利息 金额", value: "1035276.00" },
    { action: "expectNumberWithin", target: "贷款本金 金额", value: "2100000.00" },
    { action: "expectNumberWithin", target: "还款总金额 金额", value: "3135276.00" },
  ],
}]);
assert.equal((numericRegions[0].steps[5] as { value: string }).value, "9844.97");
assert.equal((numericRegions[0].steps[6] as { value: string }).value, "1444190.24");
assert.equal((numericRegions[0].steps[7] as { value: string }).value, "2100000.00");
assert.equal((numericRegions[0].steps[8] as { value: string }).value, "3544190.24");
assert.deepEqual(mortgageExpectationIssues(numericRegions), []);

const implicitWanFromPrincipal = normalizeMortgageExpectations([{
  name: "计算房贷月供、总利息与总还款额",
  covers: ["月供", "总利息"],
  steps: [
    { action: "fill", target: "购房总价", value: "200" },
    { action: "fill", target: "首付比例", value: "50" },
    { action: "fill", target: "贷款年利率", value: "4.9" },
    { action: "fill", target: "贷款年限", value: "30" },
    { action: "click", target: "计算月供" },
    { action: "expectNumberWithin", target: "月供金额", value: "0.53" },
    { action: "expectNumberWithin", target: "贷款总额", value: "1000000.00" },
    { action: "expectNumberWithin", target: "总利息", value: "91.06" },
    { action: "expectNumberWithin", target: "总还款额", value: "1910617.20" },
  ],
}]);
assert.equal((implicitWanFromPrincipal[0].steps[5] as { value: string }).value, "5307.27");
assert.equal((implicitWanFromPrincipal[0].steps[6] as { value: string }).value, "1000000.00");
assert.equal((implicitWanFromPrincipal[0].steps[7] as { value: string }).value, "910616.19");
assert.equal((implicitWanFromPrincipal[0].steps[8] as { value: string }).value, "1910616.19");
assert.deepEqual(mortgageExpectationIssues(implicitWanFromPrincipal), []);

const fourthTotalPayment = normalizeMortgageExpectations([{
  name: "正常计算月供与总利息",
  covers: ["月供", "总利息"],
  steps: [
    { action: "fill", target: "房屋总价", value: "3000000" },
    { action: "fill", target: "首付比例", value: "30" },
    { action: "fill", target: "年利率", value: "3.85" },
    { action: "fill", target: "贷款年限", value: "30" },
    { action: "click", target: "计算" },
    { action: "expectTextWithin", target: "计算结果", text: "9,844.97" },
    { action: "expectTextWithin", target: "计算结果", text: "1,444,190.24" },
    { action: "expectTextWithin", target: "计算结果", text: "2,100,000.00" },
    { action: "expectTextWithin", target: "计算结果", text: "1,439,772.00" },
  ],
}]);
assert.equal((fourthTotalPayment[0].steps[8] as { text: string }).text, "3,544,190.24");

const readOnlyValueAssertions = normalizeMortgageExpectations([{
  name: "输入贷款参数并计算月供与总利息",
  covers: ["月供", "总利息"],
  steps: [
    { action: "fill", target: "房屋总价", value: "300" },
    { action: "fill", target: "首付比例", value: "30" },
    { action: "fill", target: "年利率", value: "3.85" },
    { action: "fill", target: "贷款年限", value: "30" },
    { action: "click", target: "计算月供" },
    { action: "expectValue", target: "月供金额", value: "10,953.91" },
    { action: "expectValue", target: "贷款总额", value: "2,100,000.00" },
    { action: "expectValue", target: "总利息", value: "1,843,407.60" },
  ],
}]);
assert.equal(readOnlyValueAssertions[0].steps[5].action, "expectNumberWithin");
assert.equal((readOnlyValueAssertions[0].steps[5] as { value: string }).value, "9844.97");
assert.equal((readOnlyValueAssertions[0].steps[6] as { value: string }).value, "2100000.00");
assert.equal((readOnlyValueAssertions[0].steps[7] as { value: string }).value, "1444190.24");
assert.deepEqual(mortgageExpectationIssues(readOnlyValueAssertions), []);

const suiteUnitEvidence = normalizeMortgageExpectations([
  {
    name: "正常计算",
    covers: ["月供", "总利息"],
    steps: [
      { action: "fill", target: "房屋总价", value: "300" },
      { action: "fill", target: "首付比例", value: "30" },
      { action: "fill", target: "年利率", value: "3.85" },
      { action: "fill", target: "贷款年限", value: "30" },
      { action: "click", target: "计算" },
      { action: "expectText", text: "0.98" },
      { action: "expectText", text: "144.42" },
      { action: "expectText", text: "2,100,000.00" },
      { action: "expectText", text: "354.42" },
    ],
  },
  {
    name: "零利率边界",
    covers: ["月供", "总利息"],
    steps: [
      { action: "fill", target: "房屋总价", value: "100" },
      { action: "fill", target: "首付比例", value: "20" },
      { action: "fill", target: "年利率", value: "0" },
      { action: "fill", target: "贷款年限", value: "10" },
      { action: "click", target: "计算" },
      { action: "expectText", text: "0.67" },
      { action: "expectText", text: "0.00" },
      { action: "expectText", text: "80.00" },
      { action: "expectText", text: "80.00" },
    ],
  },
]);
assert.equal((suiteUnitEvidence[0].steps[5] as { text: string }).text, "9844.97");
assert.equal((suiteUnitEvidence[0].steps[8] as { text: string }).text, "3544190.24");
assert.equal((suiteUnitEvidence[1].steps[5] as { text: string }).text, "6666.67");
assert.equal((suiteUnitEvidence[1].steps[7] as { text: string }).text, "800000.00");

const sourceUnitEvidence = normalizeMortgageExpectations([{
  name: "正常输入计算月供与总利息",
  covers: ["月供", "总利息"],
  steps: [
    { action: "fill", target: "房屋总价", value: "300" },
    { action: "fill", target: "首付比例", value: "30" },
    { action: "fill", target: "贷款年利率", value: "4.2" },
    { action: "fill", target: "贷款年限", value: "30" },
    { action: "click", target: "计算月供" },
    { action: "expectText", text: "¥1.03" },
    { action: "expectText", text: "¥159.70" },
  ],
}], "const loanPrincipal = totalPrice * 10000 * (1 - downPaymentRatio / 100)");
assert.equal((sourceUnitEvidence[0].steps[5] as { text: string }).text, "¥10269.36");
assert.equal((sourceUnitEvidence[0].steps[6] as { text: string }).text, "¥1596969.83");
assert.deepEqual(mortgageExpectationIssues(sourceUnitEvidence), []);

console.log("Calculation plan · ✓ 错误房贷期望被拒，带币种或结果卡纯数值均可复算");
