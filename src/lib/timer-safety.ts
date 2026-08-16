/**
 * 计时器生命周期静态审计。
 *
 * 只在源码出现 `setInterval` 时启用(enabled),否则直接放行 —— 没有计时器的场景不受打扰。
 * 判定的不是「有没有 bug」,而是「有没有留下注定出问题的写法」,全部是源码级别的可审计证据:
 *
 *   A1 有 setInterval 就必须有 clearInterval —— 否则定时器没有清理路径,暂停/重置/卸载都停不下来。
 *   A2 有 setInterval 的组件要有 useEffect 卸载清理(return () => ...)—— 保证卸载时释放。
 *   A3 任何副作用都不得放进 setState 函数式更新器内 ——
 *      db.insert/update/remove/fetch、嵌套 setState、setInterval/clearInterval、
 *      ref.current 赋值,以及调用**本身或下游含上述副作用**的 helper。
 *      更新器可能被重复调用(React StrictMode 会故意调用两次),副作用会重复执行。
 *      用最小调用传播识别「更新器调 helper、helper 内藏 db/setState」的写法。
 *   B  保守的 stale-closure:setMode/setPhase 等「切模式」后**立即**调用某个计时器启动函数,
 *      而该启动函数内部的 setInterval 回调又读取同一个 state 变量 → 极可能捕获旧闭包。
 *      典型如 setMode('rest') 后再 startTimer(),startTimer 闭包仍是 mode='focus',
 *      休息结束会走专注完成分支,重复记 completedPomodoros。
 *
 * 全部用保守模式匹配(宁可不抓,也不误伤),返回的 reasons 直接可进审计、可回喂修复。
 */

export interface TimerSafetyReport {
  /** 是否启用(源码里有没有 setInterval) */
  enabled: boolean;
  ok: boolean;
  reasons: string[];
}

/** setMode 之后多近的调用算「立即」 */
const STARTER_WINDOW = 300;

function lowerFirst(s: string): string {
  return s[0]?.toLowerCase() + s.slice(1);
}

/**
 * 从函数定义位置提取「真实函数体」——用花括号平衡匹配,而不是固定字符窗口。
 * 固定窗口会让紧挨着下一个函数的 body 串进前一个函数
 * (典型: stopInterval 紧邻 startTimer,窗口重叠 → stopInterval 被误判成计时器启动器)。
 */
function extractBody(all: string, fromIndex: number, isArrow: boolean): string | null {
  let bodyOpen = -1;
  if (isArrow) {
    const arrow = all.indexOf("=>", fromIndex);
    if (arrow === -1) return null;
    bodyOpen = all.indexOf("{", arrow);
  } else {
    const paren = all.indexOf("(", fromIndex);
    if (paren === -1) return null;
    let depth = 0;
    let close = -1;
    for (let i = paren; i < all.length; i++) {
      if (all[i] === "(") depth++;
      else if (all[i] === ")") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) return null;
    bodyOpen = all.indexOf("{", close);
  }
  if (bodyOpen === -1) return null;
  let depth = 0;
  for (let i = bodyOpen; i < all.length; i++) {
    if (all[i] === "{") depth++;
    else if (all[i] === "}") {
      depth--;
      if (depth === 0) return all.slice(bodyOpen, i + 1);
    }
  }
  return null;
}

/**
 * 找出所有「函数体内真正含 setInterval」的函数名及其 body。
 * 这些是计时器启动器 —— 切模式后调用它们、且它们读旧 state,就是 stale-closure 的来源。
 */
function timerStarters(all: string): Map<string, string> {
  const map = new Map<string, string>();
  const re =
    /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(all)) !== null) {
    const isArrow = m[2] !== undefined;
    const name = m[1] ?? m[2];
    if (!name) continue;
    const body = extractBody(all, m.index, isArrow);
    if (body && /\bsetInterval\s*\(/.test(body)) map.set(name, body);
  }
  return map;
}

/* ------------------------- A3 更新器副作用检测 ------------------------- */

const DB_CALL_RE = /\bdb\.\w+\s*\(/;
const FETCH_RE = /\bfetch\s*\(/;
/** 嵌套 setState:setXxx( 排除 setInterval/setTimeout/setState 本身 */
const NESTED_SETTER_RE = /\bset(?!Interval|Timeout|State\b)[A-Z][A-Za-z0-9]*\s*\(/g;
const TIMER_OP_RE = /\b(?:setInterval|setTimeout|clearInterval|clearTimeout)\s*\(/;
const REF_MUT_RE = /\b[A-Za-z_$][\w$]*Ref\.current\s*=/;

/**
 * 收集文件里所有「局部函数」定义(name → brace-matched body):
 * 函数声明、const/let/var 箭头函数、useCallback 包裹的箭头函数。
 * A3 需要做最小调用传播:更新器里调用某个 helper,要能查到这个 helper
 * (及其下游)内部有没有藏 setState / db / fetch / 定时器 / ref 赋值。
 */
function collectFunctions(all: string): Map<string, string> {
  const map = new Map<string, string>();
  const re =
    /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useCallback\s*\(|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(all)) !== null) {
    const isArrow = m[1] === undefined;
    const name = m[1] ?? m[2];
    if (!name) continue;
    const body = extractBody(all, m.index, isArrow);
    if (body) map.set(name, body);
  }
  return map;
}

/** 一个函数体的直接信号 + 它调用的其它局部函数名 */
function bodySignals(body: string, fnNames: string[]): { direct: string[]; calls: string[] } {
  const direct: string[] = [];
  if (DB_CALL_RE.test(body)) direct.push("db 数据读写(db.insert/update/remove/list 等)");
  if (FETCH_RE.test(body)) direct.push("fetch()");
  const setters = body.match(NESTED_SETTER_RE);
  if (setters) direct.push(`嵌套 setState(${[...new Set(setters)].join(", ")})`);
  if (TIMER_OP_RE.test(body))
    direct.push("定时器操作(setInterval/setTimeout/clearInterval/clearTimeout)");
  if (REF_MUT_RE.test(body)) direct.push("ref.current 赋值");
  const calls: string[] = [];
  for (const n of fnNames) {
    if (new RegExp(`\\b${n}\\s*\\(`).test(body)) calls.push(n);
  }
  return { direct, calls };
}

/** 把「直接含副作用」或「调用已污染函数」传播到稳定点 */
function taintedFunctions(fns: Map<string, string>): Set<string> {
  const names = [...fns.keys()];
  const sig = new Map<string, { direct: string[]; calls: string[] }>();
  for (const [n, b] of fns) sig.set(n, bodySignals(b, names));
  const tainted = new Set<string>();
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 100) {
    changed = false;
    for (const n of names) {
      if (tainted.has(n)) continue;
      const s = sig.get(n)!;
      if (s.direct.length > 0) {
        tainted.add(n);
        changed = true;
        continue;
      }
      for (const c of s.calls) {
        if (c !== n && tainted.has(c)) {
          tainted.add(n);
          changed = true;
          break;
        }
      }
    }
  }
  return tainted;
}

/**
 * 找出所有「函数式更新器」的 setter 名与其真实 body(花括号体或表达式体)。
 * 用括号平衡确定 setXxx(...) 的收尾,再用花括号匹配截出函数体 ——
 * 不会把紧邻的其它调用串进来,也不会漏掉表达式体。
 */
function updaters(all: string): { setter: string; body: string }[] {
  const out: { setter: string; body: string }[] = [];
  const re = /\bset([A-Z][A-Za-z0-9]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(all)) !== null) {
    const setter = m[1];
    if (setter === "Interval" || setter === "Timeout" || setter === "State") continue;
    const open = all.indexOf("(", m.index);
    if (open === -1) continue;
    let depth = 0;
    let close = -1;
    for (let i = open; i < all.length; i++) {
      if (all[i] === "(") depth++;
      else if (all[i] === ")") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue;
    const inner = all.slice(open + 1, close);
    const am = inner.match(/^\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
    if (!am) continue;
    const arrowEnd = open + 1 + am[0].lastIndexOf("=>") + 2;
    const after = all.slice(arrowEnd, close);
    const brace = after.indexOf("{");
    let body: string;
    if (brace !== -1) {
      const bodyOpen = arrowEnd + brace;
      let d = 0;
      let end = -1;
      for (let i = bodyOpen; i <= close; i++) {
        if (all[i] === "{") d++;
        else if (all[i] === "}") {
          d--;
          if (d === 0) {
            end = i;
            break;
          }
        }
      }
      body = end === -1 ? after : all.slice(bodyOpen, end + 1);
    } else {
      body = after; // 表达式体
    }
    out.push({ setter, body });
    re.lastIndex = close + 1;
  }
  return out;
}

/** A3:函数式更新器里出现的副作用 / 嵌套 setState / 被污染 helper 调用 */
function auditUpdaterSideEffects(all: string): string[] {
  const fns = collectFunctions(all);
  const tainted = taintedFunctions(fns);
  const fnNames = [...fns.keys()];
  const reasons: string[] = [];
  for (const { setter, body } of updaters(all)) {
    const { direct, calls } = bodySignals(body, fnNames);
    const taintedCalls = calls.filter((c) => tainted.has(c));
    if (direct.length === 0 && taintedCalls.length === 0) continue;
    const bits: string[] = [];
    if (direct.length > 0) bits.push(`直接出现 ${direct.join("、")}`);
    if (taintedCalls.length > 0)
      bits.push(`调用 ${taintedCalls.join("、")}()(其内部/下游含 setState 或 db/fetch 等副作用)`);
    reasons.push(
      `setState 函数式更新器 set${setter}((prev) => ...) 内部出现了副作用 —— ${bits.join("; ")}。` +
        `更新器可能被重复调用(StrictMode 会调用两次),副作用会重复执行,` +
        `也会引发嵌套 setState 的连锁渲染。请把副作用移到事件处理器或 useEffect,更新器只做纯计算并 return 新值。`,
    );
  }
  return reasons;
}

/**
 * 平滑滚动后紧跟一次同步偏移 —— 锚点导航「点了没反应」的经典写法。
 *
 * ```js
 * el.scrollIntoView({ behavior: "smooth" });  // 异步动画
 * window.scrollBy(0, -64);                    // 立刻同步执行
 * ```
 * 意图是补偿固定顶栏的高度,实际是同步的 scrollBy 打断了刚开始的平滑动画,
 * 而此刻位置还没动,往上滚 -64 又被夹回 0 —— **净效果是完全不动**。
 *
 * 为什么必须靠静态审计抓:jsdom 没有布局引擎,scrollIntoView 是空实现、
 * scrollY 恒为 0,执行器**根本观察不到滚动**;而单页锚点站点的所有区块
 * 本来就都在 DOM 里,点完导航后任何 expectText 都会空洞地通过。
 * 也就是说这类缺陷能穿过全部功能验收 —— 实测里它就是这么交付出去的。
 */
function auditSmoothScrollOffset(all: string): string[] {
  const reasons: string[] = [];
  const re = /scrollIntoView\s*\(\s*\{[^}]*behavior\s*:\s*["']smooth["'][^}]*\}\s*\)\s*;?\s*([\s\S]{0,120})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(all)) !== null) {
    // 只看紧随其后的这一小段:中间隔着别的语句就不是这个模式
    const tail = m[1].split(/\n\s*\n/)[0];
    if (/\bwindow\s*\.\s*scroll(By|To)\s*\(|(?<!\.)\bscrollBy\s*\(/.test(tail)) {
      reasons.push(
        "scrollIntoView({behavior:'smooth'}) 之后紧跟同步的 window.scrollBy/scrollTo —— " +
          "平滑滚动是异步动画,同步偏移会立刻打断它,而此刻位置还没变," +
          "结果往往是**点了导航完全不动**。要补偿固定顶栏,请改用 " +
          "`window.scrollTo({ top: el.offsetTop - 顶栏高度, behavior: 'smooth' })` 一次到位," +
          "或给目标区块加 CSS `scroll-margin-top`。",
      );
    }
  }
  return reasons;
}

export function auditTimerSafety(files: { path: string; content: string }[]): TimerSafetyReport {
  const all = files.map((f) => f.content).join("\n\n");

  // 滚动这一档与计时器无关,单独判定是否适用,否则没有 setInterval 的站点整档审计都被跳过
  const scrollReasons = auditSmoothScrollOffset(all);
  if (!/\bsetInterval\s*\(/.test(all)) {
    return {
      enabled: scrollReasons.length > 0,
      ok: scrollReasons.length === 0,
      reasons: [...new Set(scrollReasons)],
    };
  }

  const reasons: string[] = [...scrollReasons];

  // A1 清理函数
  if (!/\bclearInterval\s*\(/.test(all)) {
    reasons.push(
      "使用了 setInterval 但没有出现 clearInterval —— 定时器没有任何清理路径(暂停/重置/卸载都停不下来)",
    );
  }

  // A2 effect 卸载清理
  if (!/return\s*\(\s*\)\s*=>/.test(all)) {
    reasons.push(
      "使用了 setInterval 的组件没有 useEffect 卸载清理(return () => ...)—— 卸载或模式切换后定时器会继续跑",
    );
  }

  // A3 副作用不得放在 setState 函数式更新器内(含嵌套 setState / helper 调用传播)
  for (const r of auditUpdaterSideEffects(all)) reasons.push(r);

  // B 切模式后立即启动读同一 state 的计时器 → stale-closure
  const starters = timerStarters(all);
  const setterRe = /\bset([A-Z][A-Za-z0-9]*)\s*\(/g;
  let sm: RegExpExecArray | null;
  while ((sm = setterRe.exec(all)) !== null) {
    const cap = sm[1];
    // setInterval / setTimeout / 泛化 setState 不是业务状态,跳过
    if (cap === "Interval" || cap === "Timeout" || cap === "State") continue;
    const stateVar = lowerFirst(cap);
    const after = all.slice(sm.index, sm.index + STARTER_WINDOW);
    for (const [name, body] of starters) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(after) && new RegExp(`\\b${stateVar}\\b`).test(body)) {
        reasons.push(
          `set${cap}(...) 之后立即调用了 ${name}(),而 ${name} 内部的 setInterval 回调引用了 ${stateVar} —— ` +
            `set${cap} 是异步的,${name} 闭包仍捕获上一次渲染的 ${stateVar},切模式后按旧值结算` +
            `(如休息结束却走专注完成分支重复计数)。请显式把 next${cap} 传给启动器,或通过 ref 读取当前 ${stateVar}。`,
        );
      }
    }
  }

  return { enabled: true, ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}
