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

const habitSource = `
  import { createRoot } from "react-dom/client";
  import { useCallback, useEffect, useState } from "react";
  function key(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return \`${"${y}"}-${"${m}"}-${"${d}"}\`;
  }
  function streakOf(dates, today) {
    const seen = new Set(dates);
    let cursor = new Date(today + "T00:00:00");
    let streak = 0;
    while (seen.has(key(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }
  function App() {
    const [currentDay, setCurrentDay] = useState(key(new Date()));
    const [checkins, setCheckins] = useState([]);
    useEffect(() => {
      const timer = setInterval(() => setCurrentDay(key(new Date())), 60_000);
      return () => clearInterval(timer);
    }, []);
    const checkin = useCallback(() => {
      const today = key(new Date());
      setCheckins((previous) => previous.includes(today) ? previous : [...previous, today]);
    }, []);
    const checked = checkins.includes(currentDay);
    const streak = streakOf(checkins, currentDay);
    return <main>
      <button aria-label="阅读 打卡" disabled={checked} onClick={checkin}>打卡</button>
      <span aria-label="阅读 连续天数">{streak}</span>
      <span>{currentDay}</span>
    </main>;
  }
  createRoot(document.getElementById("root")).render(<App />);
`;

async function bundle(contents: string, runId: string) {
  const built = await esbuild.build({
    stdin: { contents, loader: "jsx", resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  return appHtml({
    title: "可控日期",
    js: built.outputFiles?.[0]?.text ?? "",
    css: "",
    runId,
    apiBase: "",
    embed: true,
  });
}

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

  const habitHtml = await bundle(habitSource, "calendar-habit");
  const habitReport = await runTests(habitHtml, "calendar-habit", [{
    name: "跨日刷新后按钮可再次打卡并累计连续天数",
    steps: [
      { action: "click", target: "阅读 打卡" },
      { action: "expectNumberWithin", target: "阅读 连续天数", value: "1" },
      { action: "advanceTime", ms: 86_400_000 },
      { action: "click", target: "阅读 打卡" },
      { action: "expectNumberWithin", target: "阅读 连续天数", value: "2" },
      { action: "advanceTime", ms: 172_800_000 },
      { action: "expectNumberWithin", target: "阅读 连续天数", value: "0" },
    ],
  }]);
  assert.equal(habitReport.failed, 0, JSON.stringify(habitReport.failures));
  console.log("Wall-clock timer · ✓ 页面保持打开时跨日累计与漏打重置均可观察");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
