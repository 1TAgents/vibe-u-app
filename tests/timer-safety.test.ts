/**
 * 计时器生命周期静态审计的确定性测试。
 *
 * 样例刻意通用化(不出现「番茄钟」文案),只匹配代码形态 —— 这样审计能泛化到
 * 任意倒计时 / 轮询 / 自动保存的产物,而不是只认得一个场景。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditTimerSafety } from "../src/lib/timer-safety";

// 0) 没有 setInterval 的场景不受打扰:禁用且放行
const noTimer = auditTimerSafety([{ path: "/App.js", content: "export default () => null" }]);
assert.equal(noTimer.enabled, false);
assert.equal(noTimer.ok, true);
console.log("Timer safety · ✓ 无 setInterval 时审计禁用并放行");

// 1) A1:有 setInterval 却没有任何 clearInterval
const noClear = auditTimerSafety([
  {
    path: "/App.js",
    content: `
export default function App() {
  const [n, setN] = useState(0);
  useEffect(() => {
    setInterval(() => setN((x) => x + 1), 1000);
    return () => {};
  }, []);
  return null;
}`,
  },
]);
assert.equal(noClear.enabled, true);
assert.equal(noClear.ok, false);
assert.ok(noClear.reasons.some((r) => /clearInterval/.test(r)), "应指出缺少 clearInterval");
console.log("Timer safety · ✓ setInterval 无 clearInterval 被拒");

// 2) A2:有 clearInterval 但没有 effect 卸载清理
const noCleanup = auditTimerSafety([
  {
    path: "/App.js",
    content: `
export default function App() {
  const [n, setN] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    ref.current = setInterval(() => setN((x) => x + 1), 1000);
  }, []);
  const stop = () => clearInterval(ref.current);
  return null;
}`,
  },
]);
assert.equal(noCleanup.ok, false);
assert.ok(noCleanup.reasons.some((r) => /卸载清理|return \(\) =>/.test(r)), "应指出缺少 effect 清理");
console.log("Timer safety · ✓ 无 useEffect 卸载清理被拒");

// 3) A3:副作用(db.insert)放进 setState 函数式更新器
const sideEffectInUpdater = auditTimerSafety([
  {
    path: "/App.js",
    content: `
export default function App() {
  const [items, setItems] = useState([]);
  const ref = useRef(null);
  useEffect(() => {
    ref.current = setInterval(() => {
      setItems((prev) => {
        db.insert("todos", { t: 1 });
        return [...prev, { t: 1 }];
      });
    }, 1000);
    return () => clearInterval(ref.current);
  }, []);
  return null;
}`,
  },
]);
assert.equal(sideEffectInUpdater.ok, false);
assert.ok(
  sideEffectInUpdater.reasons.some((r) => /函数式更新器|db\.insert/.test(r)),
  "应指出副作用进了函数式更新器",
);
console.log("Timer safety · ✓ db 副作用放进 setState 函数式更新器被拒");

// 4) B:切模式后立即调用读同一 state 的计时器启动器(旧闭包)
const staleClosure = auditTimerSafety([
  {
    path: "/App.js",
    content: `
export default function App() {
  const [mode, setMode] = useState("focus");
  const [secondsLeft, setSecondsLeft] = useState(1500);
  const ref = useRef(null);
  const stop = () => { if (ref.current) clearInterval(ref.current); };
  const startTimer = () => {
    ref.current = setInterval(() => {
      if (mode === "focus") { setSecondsLeft((p) => p - 1); }
      else { setSecondsLeft((p) => p - 1); }
    }, 1000);
  };
  useEffect(() => { return () => stop(); }, []);
  const handleRest = () => {
    setMode("rest");
    setSecondsLeft(300);
    startTimer();
  };
  return null;
}`,
  },
]);
assert.equal(staleClosure.ok, false);
assert.ok(
  staleClosure.reasons.some((r) => /setMode|startTimer|stale|闭包/.test(r)),
  "应指出切模式后用旧闭包启动计时器",
);
console.log("Timer safety · ✓ setMode 后用旧闭包启动计时器被拒");

// 5) 安全实现:显式传 nextMode 给启动器,单一 interval ref + effect 清理,无副作用进更新器
const safe = auditTimerSafety([
  {
    path: "/App.js",
    content: `
export default function App() {
  const [mode, setMode] = useState("focus");
  const ref = useRef(null);
  const stop = () => { if (ref.current) { clearInterval(ref.current); ref.current = null; } };
  const startTimer = (nextMode) => {
    if (ref.current) return;
    ref.current = setInterval(() => {
      if (nextMode === "focus") { /* 专注完成 */ }
      else { /* 休息结束 */ }
    }, 1000);
  };
  useEffect(() => { return () => stop(); }, []);
  const handleRest = () => { setMode("rest"); startTimer("rest"); };
  const handleStart = () => { setMode("focus"); startTimer("focus"); };
  return null;
}`,
  },
]);
assert.equal(safe.enabled, true);
assert.equal(safe.ok, true, "显式传 nextMode 的安全实现应通过审计");
assert.deepEqual(safe.reasons, []);
console.log("Timer safety · ✓ 显式传 nextMode 的安全实现通过审计");

// 6) A3 回归:真实 pomodoro 最终源码(run mss0uvmx0582aq89)——
//    更新器内直接 clearInterval、赋 ref.current,并调用 handleTimerComplete
//    (下游 recordPomodoro → db.insert + setTodayCount + setMode + setSecondsLeft)。
//    旧 A3 只匹配 db/fetch 所以漏掉,必须被新传播式检测拒掉。
const pomodoroFinal = readFileSync(
  new URL("./fixtures/pomodoro-final.jsx", import.meta.url),
  "utf8",
);
const rFinal = auditTimerSafety([{ path: "/App.js", content: pomodoroFinal }]);
assert.equal(rFinal.enabled, true);
assert.equal(rFinal.ok, false, "最终源码 updater 内的副作用必须被审计拒绝(假阴修复)");
assert.ok(
  rFinal.reasons.some(
    (r) => /函数式更新器/.test(r) && /handleTimerComplete|clearInterval|ref\.current/.test(r),
  ),
  "应明确指出更新器内的副作用与 helper 调用",
);
console.log("Timer safety · ✓ 真实 pomodoro 最终源码 updater 内副作用被拒(含 helper 传播)");

// 7) 修复版:归零副作用移到 useEffect,更新器只做纯计算 → 审计通过
const pomodoroSafe = readFileSync(
  new URL("./fixtures/pomodoro-safe.jsx", import.meta.url),
  "utf8",
);
const rSafe = auditTimerSafety([{ path: "/App.js", content: pomodoroSafe }]);
assert.equal(rSafe.enabled, true);
assert.equal(rSafe.ok, true, "副作用移到 useEffect 后应通过审计");
assert.deepEqual(rSafe.reasons, []);
console.log("Timer safety · ✓ 副作用移出更新器后审计通过");

/* --- 锚点导航「点了没反应」:平滑滚动后紧跟同步偏移 --- */
{
  // 真实交付里出现过的写法:意图是补偿 64px 固定顶栏,实际是同步 scrollBy
  // 打断了刚开始的平滑动画,而此刻位置还没动,-64 又被夹回 0 —— 完全不动。
  // jsdom 没有布局引擎,scrollY 恒为 0,功能验收根本看不到这个缺陷,
  // 单页锚点站点的区块又都在 DOM 里,点完导航的 expectText 会空洞地通过。
  const r = auditTimerSafety([
    {
      path: "/components/Nav.js",
      content: `function scrollTo(id){ const el=document.getElementById(id);
        if(el){ el.scrollIntoView({ behavior: "smooth", block: "start" }); window.scrollBy(0,-64); } }`,
    },
  ]);
  assert.equal(r.ok, false, "这个组合必须被拦下");
  assert.ok(r.reasons.some((x) => /打断/.test(x)), "要说清为什么不动");
  console.log("Timer safety · ✓ 拦下平滑滚动后紧跟同步偏移(锚点导航点了不动)");
}

{
  // 一次到位的写法不该误报
  const r = auditTimerSafety([
    {
      path: "/components/Nav.js",
      content: `function scrollTo(id){ const el=document.getElementById(id);
        if(el){ window.scrollTo({ top: el.offsetTop - 64, behavior: "smooth" }); } }`,
    },
  ]);
  assert.equal(r.ok, true, "正确写法不能误报");
  console.log("Timer safety · ✓ scrollTo 一次到位不误报");
}

{
  // 纯 scrollIntoView 也不该误报
  const r = auditTimerSafety([
    {
      path: "/components/Nav.js",
      content: `document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });`,
    },
  ]);
  assert.equal(r.ok, true, "纯平滑滚动没有问题");
  console.log("Timer safety · ✓ 纯 scrollIntoView 不误报");
}
