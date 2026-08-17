/**
 * expectAttribute / expectNoAttribute 语义状态断言的确定性测试。
 *
 * 背景:低库存高亮这类**视觉条件样式**不能只靠 expectText("库存不足") 证明 —— 文案存在
 * 不等于样式生效。必须断言承载样式的元素上的语义状态标记(data-state / data-status /
 * aria-invalid / 语义 class),并证明它随边界条件出现与消失。
 *
 * 用一个真实 React 库存行(每行 <li data-state="low|ok">)验证:
 *  1) 数量减到 0 后 low 标记出现,增加越过阈值后消失(同一商品完整闭环);
 *  2) 实际是 low 却断言 ok → 明确失败(报实际值);
 *  3) 仍为 low 却断言 not low → 明确失败;
 *  4) 目标商品不存在或没有该属性 → 报「找不到」。
 */

import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { appHtml } from "../src/lib/builder";
import { runTests, type TestCase } from "../src/lib/testrunner";

const runId = `expect-attribute-${Date.now()}`;

/** 库存行:阈值 1,数量 ≤1 时 data-state=low(低库存),否则 ok */
const SOURCE = `
import { createRoot } from "react-dom/client";
import { useState } from "react";

function App() {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [done, setDone] = useState(false);
  const add = () => {
    if (!name.trim()) return;
    setItems((p) => [...p, { name: name.trim(), qty: 2, threshold: 1 }]);
    setName("");
  };
  const change = (n, d) =>
    setItems((p) =>
      p.map((it) => (it.name === n ? { ...it, qty: Math.max(0, it.qty + d) } : it)),
    );
  return (
    <div>
      <div>
        <input aria-label="商品名" value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={add}>添加</button>
      </div>
      <ul>
        {items.map((it) => {
          const low = it.qty <= it.threshold;
          return (
            <li key={it.name} data-state={low ? "low" : "ok"} aria-label={\`商品 \${it.name}\`}>
              <span>{it.name}</span>
              <input aria-label={\`\${it.name} 数量\`} readOnly value={String(it.qty)} />
              <button aria-label={\`\${it.name} 减少\`} onClick={() => change(it.name, -1)}>减少</button>
              <button aria-label={\`\${it.name} 增加\`} onClick={() => change(it.name, 1)}>增加</button>
            </li>
          );
        })}
      </ul>
      <button
        aria-label={done ? "写周报 取消完成" : "写周报 标记完成"}
        aria-pressed={done ? "true" : "false"}
        onClick={() => setDone((value) => !value)}
      >
        写周报
      </button>
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
  return appHtml({ title: "库存管理", js, css: "", runId, apiBase: "", embed: true });
}

const cases: TestCase[] = [
  {
    name: "苹果数量减到 0 出现低库存,增加越过阈值后恢复",
    steps: [
      { action: "fill", target: "商品名", value: "苹果" },
      { action: "click", target: "添加" },
      { action: "expectAttribute", target: "苹果", attr: "data-state", value: "ok" },
      { action: "click", target: "苹果 减少" },
      { action: "click", target: "苹果 减少" },
      { action: "expectValue", target: "苹果 数量", value: "0" },
      { action: "click", target: "苹果 减少" },
      { action: "expectValue", target: "苹果 数量", value: "0" },
      { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
      { action: "click", target: "苹果 增加" },
      { action: "click", target: "苹果 增加" },
      { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
      { action: "expectAttribute", target: "苹果", attr: "data-state", value: "ok" },
    ],
  },
  {
    name: "实际为 low 却断言 ok 应失败",
    steps: [
      { action: "fill", target: "商品名", value: "苹果" },
      { action: "click", target: "添加" },
      { action: "click", target: "苹果 减少" },
      { action: "click", target: "苹果 减少" },
      { action: "expectAttribute", target: "苹果", attr: "data-state", value: "ok" },
    ],
  },
  {
    name: "仍为 low 却断言不再 low 应失败",
    steps: [
      { action: "fill", target: "商品名", value: "苹果" },
      { action: "click", target: "添加" },
      { action: "click", target: "苹果 减少" },
      { action: "click", target: "苹果 减少" },
      { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
    ],
  },
  {
    name: "目标商品不存在或没有该属性应报找不到",
    steps: [{ action: "expectAttribute", target: "香蕉", attr: "data-state", value: "low" }],
  },
  {
    name: "点击后可访问名称变化仍断言同一控件",
    steps: [
      { action: "click", target: "写周报 标记完成" },
      {
        action: "expectAttribute",
        target: "写周报 标记完成",
        attr: "aria-pressed",
        value: "true",
      },
      { action: "click", target: "写周报 取消完成" },
      {
        action: "expectAttribute",
        target: "写周报 取消完成",
        attr: "aria-pressed",
        value: "false",
      },
    ],
  },
  {
    name: "不同目标不得复用最近交互控件",
    steps: [
      { action: "click", target: "写周报 标记完成" },
      {
        action: "expectAttribute",
        target: "其他任务 标记完成",
        attr: "aria-pressed",
        value: "true",
      },
    ],
  },
];

async function main() {
  const html = await buildHtml();
  const report = await runTests(html, runId, cases);

  // 1) 完整闭环:0 → low 出现 → 增加 → low 消失 → ok → 通过
  const flow = report.failures.find((f) => f.case.includes("减到 0 出现低库存"));
  assert.ok(!flow, `完整闭环用例应通过,失败详情:${JSON.stringify(flow)}`);
  console.log("ExpectAttribute · ✓ 数量到 0 出现 low、增加后消失(同一商品闭环)");

  // 2) 实际 low 却断言 ok → 明确失败,报出实际值
  const wrongValue = report.failures.find((f) => f.case.includes("实际为 low 却断言 ok"));
  assert.ok(wrongValue, "实际为 low 却断言 ok 必须失败");
  assert.match(wrongValue.message, /「苹果」的 data-state 应为「ok」,实际「low」/);
  console.log("ExpectAttribute · ✓ 实际为 low 却断言 ok 时明确失败(报实际值)");

  // 3) 仍为 low 却断言不再 low → 明确失败
  const stillLow = report.failures.find((f) => f.case.includes("仍为 low 却断言不再 low"));
  assert.ok(stillLow, "仍为 low 却断言不再 low 必须失败");
  assert.match(stillLow.message, /不应是「low」,实际仍是「low」/);
  console.log("ExpectAttribute · ✓ 仍为 low 却断言 not low 时明确失败");

  // 4) 目标不存在 → 报「找不到」
  const missing = report.failures.find((f) => f.case.includes("不存在或没有该属性"));
  assert.ok(missing, "目标不存在应报错");
  assert.match(missing.message, /找不到带 data-state 的「香蕉」/);
  console.log("ExpectAttribute · ✓ 目标商品不存在时报「找不到」");

  // 5) 点击会改变 accessible name,但紧随其后的断言描述的是同一个控件
  const renamed = report.failures.find((f) => f.case.includes("可访问名称变化"));
  assert.ok(!renamed, `名称变化后的同控件状态断言应通过:${JSON.stringify(renamed)}`);
  console.log("ExpectAttribute · ✓ 点击后名称变化仍可断言同一控件");

  // 6) 复用严格限定为同一 target,不能把无关目标静默绑定到最近控件
  const unrelated = report.failures.find((f) => f.case.includes("不同目标不得复用"));
  assert.ok(unrelated, "不同目标不得复用最近交互控件");
  assert.match(unrelated.message, /找不到带 aria-pressed 的「其他任务 标记完成」/);
  console.log("ExpectAttribute · ✓ 不同目标不会误用最近交互控件");

  assert.equal(report.passed, 2, JSON.stringify(report.failures, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
