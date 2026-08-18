import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { appHtml } from "../src/lib/builder";
import { runTests } from "../src/lib/testrunner";

const source = `
  import { createRoot } from "react-dom/client";
  import { useRef, useState } from "react";
  function App() {
    const [status, setStatus] = useState("待开始");
    const [day, setDay] = useState(0);
    const startedOn = useRef(new Date());
    const endAt = useRef(0);
    const timer = useRef(null);
    const start = () => {
      endAt.current = Date.now() + 1500 * 1000;
      setStatus("进行中");
      timer.current = setInterval(() => {
        if (Date.now() >= endAt.current) {
          clearInterval(timer.current);
          setStatus("已完成");
        }
      }, 250);
    };
    const readDay = () => {
      const elapsed = new Date().getTime() - startedOn.current.getTime();
      setDay(Math.round(elapsed / 86400000));
    };
    return <main>
      <button onClick={start}>开始</button><p>{status}</p>
      <button onClick={readDay}>查看日期</button><p>第{day}天</p>
    </main>;
  }
  createRoot(document.getElementById("root")).render(<App />);
`;

async function main() {
  const built = await esbuild.build({
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
  const html = appHtml({
    title: "墙上时钟",
    js: built.outputFiles?.[0]?.text ?? "",
    css: "",
    runId: "wall-clock-timer",
    apiBase: "",
    embed: true,
  });
  const report = await runTests(html, "wall-clock-timer", [{
    name: "Date.now 与 interval 共用虚拟时间轴",
    steps: [
      { action: "click", target: "开始" },
      { action: "advanceTime", ms: 1_500_000 },
      { action: "expectText", text: "已完成" },
    ],
  }]);
  assert.equal(report.failed, 0, JSON.stringify(report.failures));
  console.log("Wall-clock timer · ✓ Date.now 与定时回调同步推进");

  const dateReport = await runTests(html, "calendar-clock", [{
    name: "new Date 与业务日期共用虚拟时间轴",
    steps: [
      { action: "advanceTime", ms: 86_400_000 },
      { action: "click", target: "查看日期" },
      { action: "expectText", text: "第1天" },
    ],
  }]);
  assert.equal(dateReport.failed, 0, JSON.stringify(dateReport.failures));
  console.log("Wall-clock timer · ✓ new Date 与业务日期同步推进");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
