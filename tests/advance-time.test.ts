/**
 * advanceTime 确定性时钟推进的测试。
 *
 * 验证两点:
 * 1) 不推进时钟,计时器的终态(如 25 分钟专注结束)永远到不了 —— 用例失败,
 *    这正是老 pomodoro run(msrzqqbfopjqzqgs)栽跟头的地方:Tess 点击开始后
 *    立即断言 25 分钟后才出现的文案,产品怎么写都过不了。
 * 2) advanceTime 推进 1500 秒后,完成态、计数、短休息链路都能被验证 ——
 *    jsdom 里不再需要真实等待 25 分钟。
 *
 * 用例刻意通用化(不出现「番茄钟」文案),只证明「可控时钟 + 倒计时终态」这条
 * 平台能力,任何倒计时/轮询/定时任务的产物都能复用。
 */

import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { appHtml } from "../src/lib/builder";
import { runTests, type TestCase } from "../src/lib/testrunner";

const runId = `advance-time-${Date.now()}`;

/** 一个真实 React 倒计时应用:单一 interval ref、卸载清理、归零后 effect 完成并计数 */
const SOURCE = `
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";

function App() {
  const [secondsLeft, setSecondsLeft] = useState(1500);
  const [completed, setCompleted] = useState(0);
  const [phaseDone, setPhaseDone] = useState(false);
  const ref = useRef(null);
  const modeRef = useRef("focus");

  const stop = () => {
    if (ref.current) {
      clearInterval(ref.current);
      ref.current = null;
    }
  };
  const start = (nextMode) => {
    if (ref.current) return;
    modeRef.current = nextMode;
    setPhaseDone(false);
    setSecondsLeft(nextMode === "rest" ? 300 : 1500);
    ref.current = setInterval(() => setSecondsLeft((p) => (p <= 0 ? 0 : p - 1)), 1000);
  };
  useEffect(() => {
    if (secondsLeft === 0 && ref.current) {
      stop();
      if (modeRef.current === "focus") setCompleted((c) => c + 1);
      setPhaseDone(true);
    }
  }, [secondsLeft]);
  useEffect(() => () => stop(), []);

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");
  return (
    <div>
      <div>剩余 {mm}:{ss}</div>
      <div>完成 {completed} 个</div>
      {phaseDone && <div>本阶段完成</div>}
      <button onClick={() => start("focus")}>开始专注</button>
      <button onClick={() => start("rest")}>短休息</button>
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
  return appHtml({ title: "工作计时", js, css: "", runId, apiBase: "", embed: true });
}

const cases: TestCase[] = [
  {
    name: "不推进时钟无法验证计时终态(24 分钟也等不到)",
    steps: [
      { action: "click", target: "开始专注" },
      { action: "expectText", text: "本阶段完成" },
    ],
  },
  {
    name: "advanceTime 1500 秒后验证完成态、计数与短休息链路",
    steps: [
      { action: "click", target: "开始专注" },
      { action: "advanceTime", ms: 1_500_000 },
      { action: "expectText", text: "本阶段完成" },
      { action: "expectText", text: "完成 1 个" },
      { action: "expectText", text: "剩余 00:00" },
      { action: "click", target: "短休息" },
      { action: "advanceTime", ms: 300_000 },
      { action: "expectText", text: "本阶段完成" },
      { action: "expectText", text: "剩余 00:00" },
    ],
  },
];

async function main() {
  const html = await buildHtml();

  const report = await runTests(html, runId, cases);

  // 第一条:没有 advanceTime,终态文案不应出现 → 必须失败
  const noAdvance = report.failures.find((f) => f.case.includes("不推进时钟"));
  assert.ok(noAdvance, "不推进时钟的用例应失败,而不是被当成通过");
  assert.match(noAdvance.message, /本阶段完成/, "失败原因应是等不到终态文案");
  console.log("AdvanceTime · ✓ 不推进时钟,计时终态不可达(用例明确失败)");

  // 第二条:advanceTime 推进后,完成态 / 计数 / 短休息链路全部可验证 → 必须通过
  const withAdvance = report.failures.find((f) => f.case.includes("advanceTime 1500"));
  assert.ok(!withAdvance, `推进时钟的用例应通过,失败详情:${JSON.stringify(withAdvance)}`);
  assert.equal(report.passed, 1, JSON.stringify(report.failures, null, 2));
  console.log("AdvanceTime · ✓ advanceTime 1500s 后验证完成态、计数与短休息链路");
  console.log("AdvanceTime · ✓ jsdom 无需真实等待 25 分钟");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
