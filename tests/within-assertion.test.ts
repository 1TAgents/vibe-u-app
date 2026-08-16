/**
 * expectTextWithin / expectNoTextWithin 区域归属断言的确定性测试。
 *
 * 背景:kanban run mss23y70y2291558 表面通过,但「连续流转到已完成」只做全页面
 * expectText —— 任务名全局还存在就假过,无法证明任务真的落在进行中/已完成列。
 *
 * 这里用一个真实 React 看板(待办/进行中/已完成三列,列容器带 aria-label)验证:
 *  1) 全局文字存在但落在错误列时,对正确列的 expectTextWithin 必须失败;
 *  2) 任务按「待办→进行中→已完成」流转后,各列 expectTextWithin +
 *     expectNoTextWithin 旧列全部成立;
 *  3) 目标区域不存在时报「找不到区域」,而不是静默假过。
 */

import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { appHtml } from "../src/lib/builder";
import { runTests, type TestCase } from "../src/lib/testrunner";

const runId = `within-assertion-${Date.now()}`;

/** 真实 React 看板:三列各是一个带 aria-label 的 <section>,任务可逐列右移 */
const SOURCE = `
import { createRoot } from "react-dom/client";
import { useState } from "react";

const COLUMNS = ["待办任务", "进行中任务", "已完成任务"];

function App() {
  const [tasks, setTasks] = useState([]);
  const [name, setName] = useState("");
  const add = () => {
    if (!name.trim()) return;
    setTasks((prev) => [...prev, { id: Date.now(), name: name.trim(), col: "待办任务" }]);
    setName("");
  };
  const move = (id) =>
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const i = COLUMNS.indexOf(t.col);
        return { ...t, col: COLUMNS[Math.min(COLUMNS.length - 1, i + 1)] };
      }),
    );
  return (
    <div>
      <div>
        <input aria-label="新任务" value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={add}>添加</button>
      </div>
      {COLUMNS.map((col) => (
        <section key={col} aria-label={col}>
          <h2>{col}</h2>
          <ul>
            {tasks
              .filter((t) => t.col === col)
              .map((t) => (
                <li key={t.id}>
                  {t.name}
                  <button aria-label={\`将\${t.name}移到下一列\`} onClick={() => move(t.id)}>
                    →
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
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
  return appHtml({ title: "团队看板", js, css: "", runId, apiBase: "", embed: true });
}

const cases: TestCase[] = [
  {
    name: "任务还在待办时,对进行中列的 expectTextWithin 应失败(全局存在不够)",
    steps: [
      { action: "fill", target: "新任务", value: "写周报" },
      { action: "click", target: "添加" },
      { action: "expectText", text: "写周报" },
      { action: "expectTextWithin", target: "进行中任务", text: "写周报" },
    ],
  },
  {
    name: "任务流转到已完成,各列区域断言逐步成立",
    steps: [
      { action: "fill", target: "新任务", value: "写周报" },
      { action: "click", target: "添加" },
      { action: "expectTextWithin", target: "待办任务", text: "写周报" },
      { action: "click", target: "将写周报移到下一列" },
      { action: "expectTextWithin", target: "进行中任务", text: "写周报" },
      { action: "expectNoTextWithin", target: "待办任务", text: "写周报" },
      { action: "click", target: "将写周报移到下一列" },
      { action: "expectTextWithin", target: "已完成任务", text: "写周报" },
      { action: "expectNoTextWithin", target: "进行中任务", text: "写周报" },
      { action: "expectNoTextWithin", target: "待办任务", text: "写周报" },
    ],
  },
  {
    name: "不存在的列区域时报找不到区域",
    steps: [{ action: "expectTextWithin", target: "不存在的列", text: "x" }],
  },
];

async function main() {
  const html = await buildHtml();
  const report = await runTests(html, runId, cases);

  // 1) 全局存在但列不对 → expectTextWithin 必须失败,而不是假过
  const wrongCol = report.failures.find((f) => f.case.includes("还在待办时"));
  assert.ok(wrongCol, "任务在待办时,对进行中列的 expectTextWithin 应失败");
  assert.match(wrongCol.message, /区域「进行中任务」里没有出现「写周报」/);
  console.log("Within · ✓ 全局文字存在但在错误列时,expectTextWithin 明确失败");

  // 2) 正确迁移 → 各列断言全过,且旧列 expectNoTextWithin 成立
  const migrated = report.failures.find((f) => f.case.includes("流转到已完成"));
  assert.ok(!migrated, `迁移用例应通过,失败详情:${JSON.stringify(migrated)}`);
  console.log("Within · ✓ 任务经待办→进行中→已完成,各列区域断言逐步成立");

  // 3) 区域不存在 → 报「找不到区域」,不静默假过
  const noRegion = report.failures.find((f) => f.case.includes("不存在的列"));
  assert.ok(noRegion, "不存在的区域应报错");
  assert.match(noRegion.message, /找不到区域「不存在的列」/);
  console.log("Within · ✓ 目标区域不存在时报「找不到区域」");

  assert.equal(report.passed, 1, JSON.stringify(report.failures, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
