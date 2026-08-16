/**
 * expectNumberWithin 只读数值区域断言的确定性测试。
 *
 * 背景:数量/金额/票数这类值常以 **div 文本**渲染(如库存 +/- 数量控件),
 * 不是输入框 —— expectValue 读不到;而 expectText 只做子串匹配,「12」会被
 * expectText("2") 误命中。expectNumberWithin 在指定区域(aria-label 容器)内
 * 提取**独立的数值 token** 做整体相等比较。
 *
 * 两条精度契约:
 *  - **细粒度 target**:数值断言必须钉在承载该数值的元素(如 aria-label="苹果 当前库存")上,
 *    不能只写整行商品区域 —— 同一行常同时显示「当前库存 2」与「阈值 0」,断言整行会命中
 *    阈值造成假过;
 *  - **数值 token 解析**:支持负号与千分位/小数,「-1」不能被当成「1」、「1,234」不能被当成「1」;
 *    value 为空白 / NaN / Infinity 必须显式拒绝。
 */

import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { appHtml } from "../src/lib/builder";
import { runTests, type TestCase } from "../src/lib/testrunner";

const runId = `expect-number-${Date.now()}`;

/** 只读数量展示:12,div 文本渲染,不是输入框(单一数值区域,验证严格非子串) */
const SOURCE_STRICT = `
import { createRoot } from "react-dom/client";
import { useState } from "react";

function App() {
  const [qty, setQty] = useState(12);
  return (
    <div aria-label="苹果">
      <span>苹果</span>
      <button onClick={() => setQty((q) => Math.max(0, q - 1))}>苹果 减少</button>
      <span aria-label="苹果 当前库存">当前库存 {qty}</span>
      <button onClick={() => setQty((q) => q + 1)}>苹果 增加</button>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
`;

/** 同一商品行同时显示「当前库存 2」与「阈值 0」—— 数值断言必须钉在具体度量上 */
const SOURCE_ROW = `
import { createRoot } from "react-dom/client";

function App() {
  return (
    <div aria-label="苹果" data-state="ok">
      <span>苹果</span>
      <span aria-label="苹果 当前库存">当前库存 2</span>
      <span aria-label="苹果 阈值">阈值 0</span>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
`;

/** 负号与千分位/小数展示 */
const SOURCE_SIGNED = `
import { createRoot } from "react-dom/client";

function App() {
  return (
    <div aria-label="财务">
      <span aria-label="余额">余额 -1</span>
      <span aria-label="季度总额">季度总额 1,234</span>
      <span aria-label="精确金额">精确金额 1,234.5</span>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
`;

/** 只读数量展示:初始 2,减到 0 触发低库存,增加越过阈值后恢复 */
const SOURCE_LOOP = `
import { createRoot } from "react-dom/client";
import { useState } from "react";

function App() {
  const [qty, setQty] = useState(2);
  const low = qty === 0;
  return (
    <div aria-label="苹果" data-state={low ? "low" : "ok"}>
      <span>苹果</span>
      <button onClick={() => setQty((q) => Math.max(0, q - 1))}>苹果 减少</button>
      <span aria-label="苹果 当前库存">当前库存 {qty}</span>
      <button onClick={() => setQty((q) => q + 1)}>苹果 增加</button>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
`;

async function buildHtml(source: string) {
  const result = await esbuild.build({
    stdin: { contents: source, loader: "jsx", resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const js = result.outputFiles?.[0]?.text ?? "";
  assert.ok(js.length > 0, "esbuild 应产出 bundle");
  return appHtml({ title: "库存", js, css: "", runId, apiBase: "", embed: true });
}

const strictCases: TestCase[] = [
  {
    name: "数量为 12 时精确命中数值 12",
    steps: [{ action: "expectNumberWithin", target: "苹果 当前库存", value: "12" }],
  },
  {
    name: "数值 12 不会被 2 子串误命中",
    steps: [{ action: "expectNumberWithin", target: "苹果 当前库存", value: "2" }],
  },
  {
    name: "数值 12 不会被 1 子串误命中",
    steps: [{ action: "expectNumberWithin", target: "苹果 当前库存", value: "1" }],
  },
  {
    name: "非数字 value 显式报错",
    steps: [{ action: "expectNumberWithin", target: "苹果 当前库存", value: "abc" }],
  },
  {
    name: "空白 value 显式报错",
    steps: [{ action: "expectNumberWithin", target: "苹果 当前库存", value: "" }],
  },
  {
    name: "目标区域不存在报找不到",
    steps: [{ action: "expectNumberWithin", target: "不存在的区域", value: "0" }],
  },
];

// 同一行含「当前库存 2」「阈值 0」:target 钉在「苹果 当前库存」上,value=2 必须通过、
// value=0 必须失败(命中行内阈值 0 就是假过)。
const rowCases: TestCase[] = [
  {
    name: "当前库存 2 时精确命中 2",
    steps: [{ action: "expectNumberWithin", target: "苹果 当前库存", value: "2" }],
  },
  {
    name: "当前库存 2 但断言 0 必须失败(防止命中行内阈值 0)",
    steps: [{ action: "expectNumberWithin", target: "苹果 当前库存", value: "0" }],
  },
];

const signedCases: TestCase[] = [
  {
    name: "余额 -1 命中 value -1",
    steps: [{ action: "expectNumberWithin", target: "余额", value: "-1" }],
  },
  {
    name: "余额 -1 不会被 1 误命中",
    steps: [{ action: "expectNumberWithin", target: "余额", value: "1" }],
  },
  {
    name: "季度总额 1,234 命中 value 1234",
    steps: [{ action: "expectNumberWithin", target: "季度总额", value: "1234" }],
  },
  {
    name: "季度总额 1,234 不会被 1 误命中",
    steps: [{ action: "expectNumberWithin", target: "季度总额", value: "1" }],
  },
  {
    name: "精确金额 1,234.5 命中 value 1234.5",
    steps: [{ action: "expectNumberWithin", target: "精确金额", value: "1234.5" }],
  },
  {
    name: "精确金额 1,234.5 不会被 1.5 误命中",
    steps: [{ action: "expectNumberWithin", target: "精确金额", value: "1.5" }],
  },
];

const loopCases: TestCase[] = [
  {
    name: "苹果数量减到 0 出现低库存,补货回弹后恢复",
    steps: [
      { action: "click", target: "苹果 减少" },
      { action: "click", target: "苹果 减少" },
      { action: "expectNumberWithin", target: "苹果 当前库存", value: "0" },
      { action: "click", target: "苹果 减少" },
      { action: "expectNumberWithin", target: "苹果 当前库存", value: "0" },
      { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
      { action: "click", target: "苹果 增加" },
      { action: "expectNumberWithin", target: "苹果 当前库存", value: "1" },
      { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
    ],
  },
];

async function main() {
  const htmlStrict = await buildHtml(SOURCE_STRICT);
  const repStrict = await runTests(htmlStrict, runId, strictCases);

  const hit = repStrict.failures.find((f) => f.case.includes("精确命中"));
  assert.ok(!hit, `数值 12 应精确命中,失败详情:${JSON.stringify(hit)}`);
  console.log("ExpectNumber · ✓ 区域数值 12 精确命中 value=12");

  const sub2 = repStrict.failures.find((f) => f.case.includes("2 子串"));
  assert.ok(sub2, "数值 12 被 2 误命中必须失败");
  assert.match(sub2.message, /区域「苹果 当前库存」里没有数值等于「2」/);
  console.log("ExpectNumber · ✓ 12 不被 2 子串误命中(严格数值相等)");

  const sub1 = repStrict.failures.find((f) => f.case.includes("1 子串"));
  assert.ok(sub1, "数值 12 被 1 误命中必须失败");
  assert.match(sub1.message, /没有数值等于「1」/);
  console.log("ExpectNumber · ✓ 12 不被 1 子串误命中");

  const badValue = repStrict.failures.find((f) => f.case.includes("非数字"));
  assert.ok(badValue, "非数字 value 必须报错");
  assert.match(badValue.message, /value 必须是数字/);
  console.log("ExpectNumber · ✓ 非数字 value 显式报错");

  const blankValue = repStrict.failures.find((f) => f.case.includes("空白 value"));
  assert.ok(blankValue, "空白 value 必须报错");
  assert.match(blankValue.message, /value 必须是数字/);
  console.log("ExpectNumber · ✓ 空白 value 显式报错(不被 Number(\"\") 当 0)");

  const noRegion = repStrict.failures.find((f) => f.case.includes("区域不存在"));
  assert.ok(noRegion, "目标区域不存在必须报错");
  assert.match(noRegion.message, /找不到区域「不存在的区域」/);
  console.log("ExpectNumber · ✓ 目标区域不存在时报「找不到区域」");

  // ---- 同一行「当前库存 2、阈值 0」:细粒度 target 钉在具体度量上 ----
  const htmlRow = await buildHtml(SOURCE_ROW);
  const repRow = await runTests(htmlRow, runId, rowCases);
  const rowHit = repRow.failures.find((f) => f.case.includes("命中 2"));
  assert.ok(!rowHit, `当前库存 2 应精确命中,失败详情:${JSON.stringify(rowHit)}`);
  const rowFalsePass = repRow.failures.find((f) => f.case.includes("必须失败"));
  assert.ok(rowFalsePass, "当前库存 2 断言 0 必须失败(不能命中行内阈值 0)");
  assert.match(rowFalsePass.message, /没有数值等于「0」/);
  console.log("ExpectNumber · ✓ 同行情景:target=「苹果 当前库存」value=2 通过、value=0 失败(不假过)");

  // ---- 负号与千分位/小数 ----
  const htmlSigned = await buildHtml(SOURCE_SIGNED);
  const repSigned = await runTests(htmlSigned, runId, signedCases);
  const negHit = repSigned.failures.find((f) => f.case.includes("命中 value -1"));
  assert.ok(!negHit, `余额 -1 应命中 value -1,失败详情:${JSON.stringify(negHit)}`);
  const negMismatch = repSigned.failures.find((f) => f.case.includes("不会被 1 误命中"));
  assert.ok(negMismatch, "余额 -1 断言 1 必须失败");
  assert.match(negMismatch.message, /没有数值等于「1」/);
  console.log("ExpectNumber · ✓ -1 精确命中、不被 1 误命中");

  const commaHit = repSigned.failures.find((f) => f.case.includes("命中 value 1234"));
  assert.ok(!commaHit, `季度总额 1,234 应命中 value 1234,失败详情:${JSON.stringify(commaHit)}`);
  const commaMismatch = repSigned.failures.find((f) => f.case.includes("不会被 1 误命中"));
  assert.ok(commaMismatch, "季度总额 1,234 断言 1 必须失败");
  assert.match(commaMismatch.message, /没有数值等于「1」/);
  console.log("ExpectNumber · ✓ 1,234 命中 1234、不被 1 误命中");

  const decimalHit = repSigned.failures.find((f) => f.case.includes("命中 value 1234.5"));
  assert.ok(!decimalHit, `精确金额 1,234.5 应命中 value 1234.5,失败详情:${JSON.stringify(decimalHit)}`);
  const decimalMismatch = repSigned.failures.find((f) => f.case.includes("不会被 1.5 误命中"));
  assert.ok(decimalMismatch, "精确金额 1,234.5 断言 1.5 必须失败");
  assert.match(decimalMismatch.message, /没有数值等于「1.5」/);
  console.log("ExpectNumber · ✓ 1,234.5 命中 1234.5、不被 1.5 误命中");

  // ---- 真实闭环(只读 div 数量)→ 0 → low → 补货回弹 1 → low 消失 ----
  const htmlLoop = await buildHtml(SOURCE_LOOP);
  const repLoop = await runTests(htmlLoop, runId, loopCases);
  const loopFail = repLoop.failures.find((f) => f.case.includes("减到 0"));
  assert.ok(!loopFail, `只读 div 数量闭环应通过,失败详情:${JSON.stringify(loopFail)}`);
  console.log("ExpectNumber · ✓ 只读 div 数量闭环(0→low→补货回弹 1→low 消失)通过");

  assert.equal(repStrict.passed, 1, JSON.stringify(repStrict.failures, null, 2));
  assert.equal(repRow.passed, 1, JSON.stringify(repRow.failures, null, 2));
  assert.equal(repSigned.passed, 3, JSON.stringify(repSigned.failures, null, 2));
  assert.equal(repLoop.passed, 1, JSON.stringify(repLoop.failures, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
