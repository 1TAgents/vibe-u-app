/**
 * expectValue 字段值断言的确定性测试。
 *
 * 背景:输入框/文本域里的值不是文本节点,expectText 永远看不到它 —— 「记录跟进备注
 * 并保存」「数量增减到某个值」这类证明编辑字段真的保存/保留了内容的验收,之前根本
 * 没有断言手段,只能靠 expectText 碰运气。
 *
 * 这里用一个真实 React 表单(受控 textarea + input)验证:
 *  1) fill 后 expectValue 断言字段当前值 —— 值真的在字段里;
 *  2) 字段值不符时明确失败(不是假过);
 *  3) 目标字段不存在时报「找不到输入框」。
 */

import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { appHtml } from "../src/lib/builder";
import { runTests, type TestCase } from "../src/lib/testrunner";

const runId = `expect-value-${Date.now()}`;

/** 受控表单:跟进备注 textarea 与 数量 input 都真实持有值 */
const SOURCE = `
import { createRoot } from "react-dom/client";
import { useState } from "react";

function App() {
  const [note, setNote] = useState("");
  const [qty, setQty] = useState("0");
  return (
    <div>
      <div>
        <label>跟进备注</label>
        <textarea aria-label="跟进备注" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div>
        <label>数量</label>
        <input aria-label="数量" value={qty} onChange={(e) => setQty(e.target.value)} />
      </div>
      <button onClick={() => setQty((q) => String(Number(q) + 1))}>加一</button>
      <div>当前备注:{note || "(空)"}</div>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
`;

async function buildHtml() {
  const result = await esbuild.build({
    stdin: { contents: SOURCE, loader: "jsx", resolveDir: process.cwd() },
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
  return appHtml({ title: "客户跟进", js, css: "", runId, apiBase: "", embed: true });
}

const cases: TestCase[] = [
  {
    name: "填入跟进备注后断言字段值真的保存进了输入框",
    steps: [
      { action: "fill", target: "跟进备注", value: "已电话联系" },
      { action: "expectValue", target: "跟进备注", value: "已电话联系" },
    ],
  },
  {
    name: "数量与字段值不符时应明确失败",
    steps: [
      { action: "fill", target: "数量", value: "5" },
      { action: "expectValue", target: "数量", value: "6" },
    ],
  },
  {
    name: "字段不存在的输入框报找不到",
    steps: [{ action: "expectValue", target: "不存在的字段", value: "x" }],
  },
];

async function main() {
  const html = await buildHtml();
  const report = await runTests(html, runId, cases);

  // 1) fill 后值在字段里 → 通过
  const saved = report.failures.find((f) => f.case.includes("保存进了输入框"));
  assert.ok(!saved, `字段值断言应通过,失败详情:${JSON.stringify(saved)}`);
  console.log("ExpectValue · ✓ fill 后 expectValue 读到字段真实值");

  // 2) 值不符 → 明确失败,报出期望值
  const mismatch = report.failures.find((f) => f.case.includes("不符"));
  assert.ok(mismatch, "字段值与期望不符必须失败");
  assert.match(mismatch.message, /输入框「数量」的值不是「6」/);
  console.log("ExpectValue · ✓ 字段值不符时明确失败(值不是「6」)");

  // 3) 字段不存在 → 报「找不到输入框」
  const missing = report.failures.find((f) => f.case.includes("不存在的输入框"));
  assert.ok(missing, "字段不存在应报错");
  assert.match(missing.message, /找不到输入框「不存在的字段」/);
  console.log("ExpectValue · ✓ 目标字段不存在时报「找不到输入框」");

  assert.equal(report.passed, 1, JSON.stringify(report.failures, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
