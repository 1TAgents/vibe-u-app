/**
 * 验收测试执行器。
 *
 * 分工是刻意的:**模型只描述「测什么」,执行器决定「怎么测」。**
 *
 * 让 LLM 直接写测试脚本是行不通的 —— 它得凭空猜 DOM 选择器,
 * 猜错了测试就失败,而失败原因是「测试写错了」而不是「应用坏了」,
 * 这种噪音会毁掉整个自愈循环(模型会去修根本没坏的代码)。
 *
 * 所以模型输出的是结构化步骤(点这个字、往这个框里填、期待看到什么),
 * 由这里用**按可见文字定位**的确定性逻辑去执行。人类点界面时也是这么找按钮的,
 * 这比选择器稳得多,报错也更像人话:「找不到写着『添加』的按钮」。
 */

import { JSDOM, VirtualConsole } from "jsdom";
import type { DOMWindow } from "jsdom";
import { randomUUID } from "node:crypto";
import { handleAppData, parseAppDataUrl, type AppDataMethod } from "./appdata";

export type TestStep =
  | { action: "click"; target: string }
  | { action: "fill"; target: string; value: string }
  | { action: "expectText"; text: string }
  | { action: "expectNoText"; text: string }
  /** 把可控时钟向前推进 ms 毫秒 —— 验证计时/轮询/定时任务的终态必须用它 */
  | { action: "advanceTime"; ms: number }
  /**
   * 只在指定容器(区域的 aria-label / 标题)内断言出现。
   * 多列看板、主从详情、弹窗、页签这类把内容分组渲染的结构,区域归属必须用它:
   * 任务名全页面出现不等于它落在正确的列里,必须证明它在「进行中任务」的容器内。
   */
  | { action: "expectTextWithin"; target: string; text: string }
  /** 只在指定容器内断言不再出现 —— 验证内容真的离开了旧区域 */
  | { action: "expectNoTextWithin"; target: string; text: string }
  /**
   * 断言输入框 / 文本域当前的值等于 value。
   * 输入框里的值不是文本节点,expectText 永远看不到它 —— 编辑字段是否保留/保存了内容,
   * 只能用 expectValue 直接读字段。target 的定位规则与 fill 相同(placeholder/aria-label/关联 label)。
   */
  | { action: "expectValue"; target: string; value: string }
  /**
   * 只读数值展示的精确区域断言 —— expectTextWithin 的严格数值版。
   * 数量/金额/票数这类值常以 div 文本渲染(不是 input),expectValue 读不到;
   * expectText 又只是子串匹配,「12」会被 expectText("2") 误命中。
   * 这里在指定区域(aria-label 容器)内提取**独立的数值 token** 做数值相等比较,
   * 不依赖它是输入框,也不做子串匹配。target 定位规则与 expectTextWithin 相同。
   */
  | { action: "expectNumberWithin"; target: string; value: string }
  /**
   * 断言某个元素的语义状态属性等于 value —— 视觉条件样式(低库存高亮、告警、选中态)的确定性证据。
   * 优先 data-state/data-status/aria-invalid/语义 class 标记;attr=class 时按 classList 包含匹配,
   * 其余属性按值精确匹配。target 用可见文字/aria-label 定位,并向上找第一个带该属性的祖先。
   */
  | { action: "expectAttribute"; target: string; attr: string; value: string }
  /** 断言某个元素的语义状态属性不再等于 value(或该属性已不存在) —— 状态消失的证据 */
  | { action: "expectNoAttribute"; target: string; attr: string; value: string };

export interface TestCase {
  name: string;
  /**
   * 这条用例覆盖的 PRD P0 功能名。名称必须逐字来自 PRD，供交付前的
   * 确定性覆盖门核对；历史运行没有该字段，保持 optional 兼容回放。
   */
  covers?: string[];
  steps: TestStep[];
}

export interface TestFailure {
  case: string;
  stepIndex: number;
  step: TestStep;
  message: string;
  /** 失败时页面上实际有哪些可点的东西,便于模型判断是自己漏做了什么 */
  visible: string;
}

export interface TestReport {
  passed: number;
  failed: number;
  failures: TestFailure[];
  durationMs: number;
}

/** 每步操作后等待 React 重渲染与异步数据回来的时间 */
const SETTLE_MS = 700;
/** 断言最多重试多久(数据是异步加载的,不能一次没看到就判失败) */
const ASSERT_TIMEOUT_MS = 4000;

export async function runTests(
  html: string,
  runId: string,
  cases: TestCase[],
): Promise<TestReport> {
  const started = Date.now();
  const failures: TestFailure[] = [];
  let passed = 0;

  const suiteId = randomUUID();
  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i];
    // 每条用例都从空数据开始。否则上一条「新建」留下的记录会让下一条
    // 看到 2 条数据,既污染断言,也会诱导工程师在应用启动时清空真实数据。
    const testRunId = `${runId}__qa__${suiteId}__${i + 1}`;
    const failure = await runCase(html, testRunId, tc);
    if (failure) failures.push(failure);
    else passed++;
  }

  return {
    passed,
    failed: failures.length,
    failures,
    durationMs: Date.now() - started,
  };
}

async function runCase(
  html: string,
  runId: string,
  tc: TestCase,
): Promise<TestFailure | null> {
  const virtualConsole = new VirtualConsole();
  const crashes: string[] = [];
  const touchedCollections = new Set<string>();
  virtualConsole.on("jsdomError", (e: Error) => {
    // Tailwind 4 会生成 @property 等现代 CSS。jsdom 26 的样式解析器不完全支持,
    // 会报 Could not parse CSS stylesheet,但这不影响 DOM 交互,真实浏览器也能解析。
    // 功能 QA 只应拦 JavaScript/渲染异常;样式仍由后面的真实浏览器校验负责。
    if (e.message.includes("Could not parse CSS stylesheet")) return;
    crashes.push(e.message);
  });

  const dom = new JSDOM(html, {
    url: `http://vibeu.local/a/${runId}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      installDataShim(window, runId, touchedCollections);
      // 用可控时钟接管 setInterval/setTimeout:正常操作期间定时器不自动走
      // (确定性),只有 advanceTime 显式推进 —— 否则 25 分钟的倒计时永远等不完。
      installFakeClock(window);
    },
  });

  const win = dom.window;
  const doc = win.document;
  const context: StepContext = {};

  try {
    // 等首屏挂载与初次数据加载
    await sleep(1600);

    for (let i = 0; i < tc.steps.length; i++) {
      const step = tc.steps[i];
      const err = await execStep(doc, win, step, context);
      if (err) {
        return {
          case: tc.name,
          stepIndex: i + 1,
          step,
          message: err,
          visible: describeVisible(doc),
        };
      }
    }

    if (crashes.length > 0) {
      return {
        case: tc.name,
        stepIndex: tc.steps.length,
        step: tc.steps[tc.steps.length - 1],
        message: `操作过程中应用抛出异常:${crashes[0].slice(0, 300)}`,
        visible: describeVisible(doc),
      };
    }
    return null;
  } finally {
    win.close();
    await cleanupTestData(runId, touchedCollections);
  }
}

/**
 * 保留最近一次真实交互命中的 DOM 节点。
 *
 * 很多语义按钮在操作后会改可访问名称，例如「任务 标记完成」点击后变成
 * 「任务 取消完成」。紧随其后的状态断言仍可能用操作前名称描述同一个控件；
 * 若重新按旧名称查询，会把正确实现误报成「找不到」。这里只允许目标文字完全
 * 相同的后续属性断言复用该节点，避免把别的控件误认成刚操作的控件。
 */
interface StepContext {
  lastInteraction?: {
    target: string;
    element: HTMLElement;
  };
}

async function execStep(
  doc: Document,
  win: DOMWindow,
  step: TestStep,
  context: StepContext,
): Promise<string | null> {
  switch (step.action) {
    case "click": {
      const el = findClickable(doc, step.target);
      if (!el) return `找不到可点击的「${step.target}」`;
      context.lastInteraction = {
        target: normalizeText(step.target),
        element: el as HTMLElement,
      };
      // 用元素原生 click() 走完整的激活行为。直接 dispatchEvent 只派发一条事件,
      // 对按钮的默认动作、表单提交和 React 的委托事件并不总是等价。
      (el as HTMLElement).click();
      await sleep(SETTLE_MS);
      return null;
    }

    case "fill": {
      const el = findInput(doc, step.target);
      if (!el) return `找不到输入框「${step.target}」`;
      context.lastInteraction = {
        target: normalizeText(step.target),
        element: el,
      };
      setNativeValue(win, el, step.value);
      await sleep(SETTLE_MS);
      return null;
    }

    case "expectText": {
      const expected = normalizeText(step.text);
      const found = await waitFor(() => textOf(doc).includes(expected));
      return found ? null : `页面上没有出现「${step.text}」`;
    }

    case "expectNoText": {
      await sleep(SETTLE_MS);
      return textOf(doc).includes(normalizeText(step.text))
        ? `「${step.text}」本不该还在页面上`
        : null;
    }

    case "advanceTime": {
      await advanceFakeTime(win, step.ms);
      return null;
    }

    case "expectTextWithin": {
      const expected = normalizeText(step.text);
      let region: HTMLElement | null = null;
      // 两边都要归一化。只归一化期望值、拿原始页面文字去比,
      // 任何带空格的断言(「年假 · 张三」「1 票」「300 kg」)都必然失败 ——
      // 而这类文案在真实产品里到处都是。
      // 区域本身也可能在保存后的 loading 态短暂卸载，必须和区域内文字一起重试；
      // 只等待文字、却在第一帧立即查区域，会把正常异步重渲染误报成「找不到区域」。
      const found = await waitFor(() => {
        region = findRegion(doc, step.target);
        return !!region && normalizeText(visibleTextOf(region)).includes(expected);
      });
      if (!region) return `找不到区域「${step.target}」`;
      return found ? null : `区域「${step.target}」里没有出现「${step.text}」`;
    }

    case "expectNoTextWithin": {
      let region: HTMLElement | null = null;
      const appeared = await waitFor(() => {
        region = findRegion(doc, step.target);
        return !!region;
      });
      if (!appeared || !region) return `找不到区域「${step.target}」`;
      await sleep(SETTLE_MS);
      // 同样必须两边归一化,而且这一侧更危险:漏了归一化会让文字**永远找不到**,
      // 于是这条否定断言恒成立、静默通过 —— 假阳性比失败难查得多。
      return normalizeText(visibleTextOf(region)).includes(normalizeText(step.text))
        ? `区域「${step.target}」里不该还有「${step.text}」`
        : null;
    }

    case "expectValue": {
      const expected = normalizeText(step.value);
      const el = findInput(doc, step.target);
      if (!el) return `找不到输入框「${step.target}」`;
      const got = await waitFor(() => normalizeText(fieldValue(el)) === expected);
      return got ? null : `输入框「${step.target}」的值不是「${step.value}」`;
    }

    case "expectNumberWithin": {
      // 只读数值展示(div 文本渲染的 +/- 数量控件)的精确区域断言。
      // value 必须是一个不带空白/千分位/科学记法的普通数字:空白会被 Number("") 当成 0,
      // "Infinity"/"NaN" 又不该被当作合法断言 —— 全部显式拒绝,避免假过。
      if (!/^\s*[-+]?\d+(\.\d+)?\s*$/.test(step.value)) {
        return `expectNumberWithin 的 value 必须是数字:「${step.value}」`;
      }
      const expected = Number(step.value);
      if (!Number.isFinite(expected)) {
        return `expectNumberWithin 的 value 必须是数字:「${step.value}」`;
      }
      let region: HTMLElement | null = null;
      const ok = await waitFor(() => {
        region = findRegion(doc, step.target);
        return !!region && extractNumbers(visibleTextOf(region)).some((n) => n === expected);
      });
      if (!region) return `找不到区域「${step.target}」`;
      return ok ? null : `区域「${step.target}」里没有数值等于「${step.value}」`;
    }

    case "expectAttribute": {
      const el = findElementWithAttr(doc, step.target, step.attr)
        ?? findAttributeOnLastInteraction(context, step.target, step.attr);
      if (!el) return `找不到带 ${step.attr} 的「${step.target}」`;
      const ok = await waitFor(() => attrMatches(el, step.attr, step.value));
      if (ok) return null;
      const actual = el.getAttribute(step.attr) ?? "(无)";
      return `「${step.target}」的 ${step.attr} 应为「${step.value}」,实际「${actual}」`;
    }

    case "expectNoAttribute": {
      const el = findElementWithAttr(doc, step.target, step.attr)
        ?? findAttributeOnLastInteraction(context, step.target, step.attr);
      if (!el) return `找不到带 ${step.attr} 的「${step.target}」`;
      const ok = await waitFor(() => !attrMatches(el, step.attr, step.value));
      if (ok) return null;
      const actual = el.getAttribute(step.attr) ?? "(无)";
      return `「${step.target}」的 ${step.attr} 不应是「${step.value}」,实际仍是「${actual}」`;
    }
  }
}

/**
 * 按可见文字 / aria-label / title 定位元素,再向上找第一个带指定属性的祖先。
 * 语义标记通常挂在行/卡片容器上(如 <li data-state="low">),而 target 写的是里面的
 * 商品名 —— 必须从命中的最深文本节点一路向上,才能拿到承载状态标记的容器。
 */
function findElementWithAttr(doc: Document, label: string, attr: string): HTMLElement | null {
  const el = findElement(doc, label);
  if (!el) return null;

  return findAttributeCarrier(el, attr);
}

/** 从一个已确定的控件向自身/祖先/唯一后代寻找语义属性承载元素。 */
function findAttributeCarrier(el: HTMLElement, attr: string): HTMLElement | null {

  for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
    if (cur.hasAttribute(attr)) return cur;
  }

  // 往上找不到就往下找一次:状态标记常挂在容器**内部**那个具体控件上
  // (行是「晨跑」,aria-pressed 在行里的打卡按钮上)。
  // 只在唯一时才认 —— 一行里有多个带同名属性的控件时,挑哪个都是猜,
  // 而猜错会得到一个看起来通过了的错误断言。
  const inner = [...el.querySelectorAll<HTMLElement>(`[${attr}]`)].filter(isVisible);
  return inner.length === 1 ? inner[0] : null;
}

/**
 * 操作导致 aria-label/title/文字变化时，属性断言可继续检查刚才操作的同一控件。
 * 目标必须逐字归一化后相同，节点仍须留在当前文档且可见；任一条件不满足就
 * 回到正常的「找不到」失败，绝不拿最近一次无关控件兜底。
 */
function findAttributeOnLastInteraction(
  context: StepContext,
  target: string,
  attr: string,
): HTMLElement | null {
  const last = context.lastInteraction;
  if (!last || last.target !== normalizeText(target)) return null;
  if (!last.element.isConnected || !isVisible(last.element)) return null;
  return findAttributeCarrier(last.element, attr);
}

/** 按可见文字定位元素(不限于可点击):精确文字 → aria-label/title → 包含文字,取最深。 */
function findElement(doc: Document, label: string): HTMLElement | null {
  const norm = (s: string) => s.replace(/\s+/g, "").trim();
  const target = norm(label);
  const visible = [...doc.querySelectorAll<HTMLElement>("*")].filter(isVisible);
  if (visible.length === 0) return null;

  // 与 findClickable 同序:组合写法先判。整行文字常常正好等于「记录名+动作名」,
  // 精确匹配会命中整行,而状态属性挂在行内那个具体控件上,
  // 从行往上找祖先永远找不到它。
  const scoped = findScopedAction(doc, label, visible);
  if (scoped) return scoped as HTMLElement;

  const exact = visible.filter((e) => norm(visibleTextOf(e)) === target);
  if (exact.length > 0) return deepest(exact);

  const byAttr = visible.find(
    (e) =>
      norm(e.getAttribute("aria-label") ?? "").includes(target) ||
      norm(e.getAttribute("title") ?? "").includes(target),
  );
  if (byAttr) return byAttr;

  const partial = visible.filter((e) => norm(visibleTextOf(e)).includes(target));
  return partial.length > 0 ? deepest(partial) : null;
}

/**
 * 语义状态属性匹配:attr=class 时按 classList 包含语义标记(容忍多个 class 并存),
 * 其余属性按值精确匹配。刻意不做子串/模糊匹配 —— 状态断言必须精确,否则等于没断言。
 */
function attrMatches(el: HTMLElement, attr: string, expected: string): boolean {
  if (attr.toLowerCase() === "class") return el.classList.contains(expected);
  // disabled / checked / required 等 HTML 布尔属性以“是否存在”表达真假，
  // 合法 DOM 通常序列化成 disabled=""，不是 disabled="true"。
  // 测试计划用 value="true" 表达布尔语义时，应按属性存在判断。
  const booleanAttrs = new Set([
    "allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls",
    "default", "defer", "disabled", "formnovalidate", "hidden", "inert", "ismap",
    "itemscope", "loop", "multiple", "muted", "nomodule", "novalidate", "open",
    "playsinline", "readonly", "required", "reversed", "selected",
  ]);
  if (booleanAttrs.has(attr.toLowerCase())) {
    if (expected === "true") return el.hasAttribute(attr);
    if (expected === "false") return !el.hasAttribute(attr);
  }
  return (el.getAttribute(attr) ?? "") === expected;
}

/** 读表单字段当前值:input/textarea/select 走 .value,其余退化到可见文本。 */
function fieldValue(el: HTMLElement): string {
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
    return (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }
  return visibleTextOf(el);
}

/* ----------------------------- 元素定位 ----------------------------- */

/**
 * 按可见文字找可点击元素。
 * 优先精确匹配,再退化到包含匹配,并且优先取**最深的**匹配节点 ——
 * 否则「包含某文字」会一路命中到最外层容器,点了等于没点。
 */
function findClickable(doc: Document, label: string): Element | null {
  const allCandidates = [
    ...doc.querySelectorAll<HTMLElement>(
      'button, a, [role="button"], input[type="submit"], input[type="checkbox"], label, li, div[onclick], span[onclick]',
    ),
  ].filter(isVisible);
  const candidates = preferActiveDialog(doc, allCandidates);

  const norm = (s: string) => s.replace(/\s+/g, "").trim();
  const target = norm(label);

  // 组合写法排在**最前**。整行的文字往往正好等于「记录名+动作名」拼起来的样子
  // (一行 <li> 里是「晨跑」和一个「打卡」按钮,整行文字就是「晨跑打卡」),
  // 于是精确匹配会命中整行 —— 而行上通常没有点击处理,也没有状态属性,
  // 表现为「点了但什么都没发生」或「找不到带 aria-pressed 的…」。
  //
  // 这一档只在「容器里含记录名、且内部有个名字正好等于动作」时才触发,
  // 比整行文字碰巧相等精确得多,所以让它先判。
  const scopedFirst = findScopedAction(doc, label, candidates);
  if (scopedFirst) return scopedFirst;

  // 文字一律用「可见文本」匹配 —— 隐藏面/折叠面板里的文字不能成为点击目标
  const exact = candidates.filter((e) => norm(visibleTextOf(e)) === target);
  if (exact.length > 0) return deepest(exact);

  // aria-label / title 比模糊文字更精确,必须先匹配。比如任务内容叫
  // 「待删除任务」时,<li> 的整行文字也包含「删除任务」,若先做 contains
  // 就会点中整行而不是删除按钮。
  const byAttr = candidates.find(
    (e) =>
      norm(e.getAttribute("aria-label") ?? "").includes(target) ||
      norm(e.getAttribute("title") ?? "").includes(target),
  );
  if (byAttr) return byAttr;

  const partial = candidates.filter((e) => norm(visibleTextOf(e)).includes(target));
  if (partial.length > 0) return deepest(partial);

  return findByStableLabel(candidates, target);
}

/**
 * 忽略标签末尾会变的计数 ——「跟进中0」对上界面上的「跟进中 1」。
 *
 * 写测试计划时应用里一条数据都没有,标签自然是「跟进中 0」;
 * 等用例真跑起来、造了一条记录,它已经变成「跟进中 1」了。
 * 把计数写进 target 按构造就是脆的,而这类写法在跑批里反复出现 ——
 * 与其一遍遍要求她别这么写,不如让执行器认得「这两个说的是同一个筛选页签」。
 *
 * 只在**去掉计数后唯一命中**时才认:如果「已完成」和「已完成任务」都沾边,
 * 挑哪个都是猜,而点错页签会让后面的断言在错误的数据集上通过。
 */
function findByStableLabel(candidates: HTMLElement[], target: string): Element | null {
  const stripCount = (s: string) => s.replace(/[\s(（\[【]*\d+[\s)）\]】]*$/u, "");
  const stable = stripCount(target);
  // 目标本身没有尾随计数就没什么可放宽的,直接放弃,免得凭空扩大匹配面
  if (stable === target || stable.length === 0) return null;

  const hits = candidates.filter((e) => {
    const text = stripCount((visibleTextOf(e) ?? "").replace(/\s+/g, "").trim());
    return text.length > 0 && text === stable;
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 「记录名 + 动作」的组合定位 —— 「城外的人想进去 编辑」意思是
 * **那条摘录上的编辑按钮**,而不是一个 aria-label 恰好等于这串字的控件。
 *
 * 为什么必须支持:一个列表里每条记录都有「编辑」「删除」,光说「编辑」是有歧义的,
 * 所以测试必须指明是哪一条。而实现侧未必会把记录名写进 aria-label ——
 * 跑批里反复出现的失败正是这个:测试写「摘录 X 编辑」、「张三 通过」,
 * 实现只渲染了一个纯文字「编辑」按钮放在那行里。两边都没错,是**表达方式**没对齐。
 *
 * 从前往后逐个切分点试:前半段当记录标识去找**包含它的最小容器**,
 * 后半段当动作名在容器内精确匹配一个可点击控件。
 * 要求动作名精确相等(而不是包含),否则「删除」会命中「删除全部」这类邻居。
 */
function findScopedAction(
  doc: Document,
  label: string,
  candidates: HTMLElement[],
): Element | null {
  const norm = (s: string) => s.replace(/\s+/g, "").trim();
  const words = label.split(/[\s　]+/).filter(Boolean);
  if (words.length < 2) return null;

  // 动作词通常在最后,所以从「只有最后一个词是动作」开始试,逐步放宽
  for (let cut = words.length - 1; cut >= 1; cut--) {
    const record = norm(words.slice(0, cut).join(""));
    const action = norm(words.slice(cut).join(""));
    if (!record || !action) continue;

    // 从最小的容器往外找,取**第一个真正装得下这个动作按钮的**。
    // 不能只挑最小的那个:记录名往往包在自己的 <span> 里,而操作按钮是它的
    // **兄弟**节点,最小容器里根本没有按钮 —— 得往上退到那一行 <li> 才对。
    // 由小到大也保证了不会退过头,把整个列表当成「这条记录」。
    const holders = [...doc.querySelectorAll<HTMLElement>("*")]
      .filter((e) => isVisible(e) && norm(visibleTextOf(e)).includes(record))
      .sort((a, b) => visibleTextOf(a).length - visibleTextOf(b).length);

    for (const scope of holders) {
      const hit = candidates.find(
        (e) =>
          scope.contains(e) &&
          (norm(visibleTextOf(e)) === action ||
            norm(e.getAttribute("aria-label") ?? "") === action ||
            norm(e.getAttribute("title") ?? "") === action),
      );
      if (hit) return hit;
    }
  }
  return null;
}

/** 按 placeholder / aria-label / 关联 label 找输入框 */
function findInput(doc: Document, label: string): HTMLElement | null {
  const allInputs = [
    ...doc.querySelectorAll<HTMLElement>("input, textarea, select"),
  ].filter(isVisible);
  const inputs = preferActiveDialog(doc, allInputs);
  if (inputs.length === 0) return null;

  const norm = (s: string) => s.replace(/\s+/g, "").trim();
  const target = norm(label);

  const byAttr = inputs.find((el) =>
    ["placeholder", "aria-label", "name", "id"].some((a) =>
      norm(el.getAttribute(a) ?? "").includes(target),
    ),
  );
  if (byAttr) return byAttr;

  // 组合写法:「病假 2025.02.01 审批意见」指的是**那条记录行里**的审批意见输入框。
  // 一个列表里每条记录都有自己的备注/意见框,光说「审批意见」是有歧义的,
  // 测试必须指明哪一条 —— 点击和属性断言都已经认这种写法,输入框不认就是个坑。
  const scoped = findScopedInput(doc, label, inputs);
  if (scoped) return scoped;

  // 通过 <label for> 或包裹式 label 关联
  for (const lb of doc.querySelectorAll("label")) {
    if (!norm(visibleTextOf(lb)).includes(target)) continue;
    const forId = lb.getAttribute("for");
    if (forId) {
      const el = doc.getElementById(forId);
      if (el) return el as HTMLElement;
    }
    const inner = lb.querySelector<HTMLElement>("input, textarea, select");
    if (inner) return inner;
  }

  // 只有一个输入框时不必纠结,就是它
  return inputs.length === 1 ? inputs[0] : null;
}

/**
 * 可见模态框存在时，交互只能发生在最上层模态框里。
 *
 * 背景页面仍留在 DOM，jsdom 又没有真实的遮罩命中测试；若背景和弹窗恰好都有
 * 「添加商品」按钮或相同 placeholder，按 DOM 顺序会点到/填到遮罩后面的控件，
 * 表现成提交无效。真实浏览器用户无法点击遮罩后的页面，所以执行器也必须遵循
 * 同一交互边界。多个模态框并存时取 DOM 最后的一个，等价于常见的最高层弹窗。
 */
function preferActiveDialog<T extends HTMLElement>(doc: Document, elements: T[]): T[] {
  const dialogs = [
    ...doc.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"]'),
  ].filter(isVisible);
  const active = dialogs.at(-1);
  if (!active) return elements;
  const scoped = elements.filter((el) => active.contains(el));
  return scoped.length > 0 ? scoped : elements;
}

/**
 * 「记录名 + 字段名」的输入框定位 —— 与 findScopedAction 同一套思路。
 *
 * 列表里每条记录都有自己的备注框/意见框,光说「审批意见」是有歧义的,
 * 所以测试会写「病假 2025.02.01 审批意见」。实现侧通常不会把整条记录的
 * 标识拼进 placeholder,于是全字匹配一律落空。
 *
 * 前半段当记录标识找**装得下这个输入框的最小容器**,后半段当字段名匹配。
 * 字段名这里用包含匹配(placeholder 常写成「填写审批意见…」这种带修饰的长句),
 * 但要求容器内**唯一**命中 —— 一行里有多个都沾边的输入框时,挑哪个都是猜,
 * 而填错框会得到一个看起来跑通了的错误用例。
 */
function findScopedInput(
  doc: Document,
  label: string,
  inputs: HTMLElement[],
): HTMLElement | null {
  const norm = (s: string) => s.replace(/\s+/g, "").trim();
  const words = label.split(/[\s　]+/).filter(Boolean);
  if (words.length < 2) return null;

  const nameOfInput = (el: HTMLElement) =>
    norm(
      el.getAttribute("placeholder") ??
        el.getAttribute("aria-label") ??
        el.getAttribute("name") ??
        "",
    );

  for (let cut = words.length - 1; cut >= 1; cut--) {
    const record = norm(words.slice(0, cut).join(""));
    const field = norm(words.slice(cut).join(""));
    if (!record || !field) continue;

    const holders = [...doc.querySelectorAll<HTMLElement>("*")]
      .filter((e) => isVisible(e) && norm(visibleTextOf(e)).includes(record))
      .sort((a, b) => visibleTextOf(a).length - visibleTextOf(b).length);

    for (const scope of holders) {
      const hits = inputs.filter(
        (el) => scope.contains(el) && nameOfInput(el).includes(field),
      );
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return null; // 歧义就别猜,如实报找不到
    }
  }
  return null;
}

/**
 * 按可访问名称定位一个「区域容器」—— 多列看板、主从详情、页签、弹窗这类
 * 把内容分组渲染的结构。expectTextWithin / expectNoTextWithin 只在该容器内断言:
 * 任务名全页面出现不等于它落在正确的列里,必须证明它在「进行中任务」的容器里。
 *
 * 定位优先级(确定性):
 *  1) aria-label 精确匹配 —— 最明确,模型应优先用它(如 <section aria-label="进行中任务">);
 *  2) aria-labelledby 指向的标题文字精确匹配;
 *  3) 内部标题(h1..h6)文字精确匹配 —— 「标题关联 section」的兜底;
 *  4) title 属性包含匹配 —— 最宽松的最后手段。
 * 前三种多命中时:label/labelledby 取最深的(和 findClickable 一致,避免点到外层包装);
 * 标题兜底取**可见文字最长**的 —— 标题所在的最小包装只含标题,不是要断言的区域,
 * 真正的列容器同时含标题与任务列表,文字必然更长。
 */
function findRegion(doc: Document, target: string): HTMLElement | null {
  const norm = (s: string) => s.replace(/\s+/g, "").trim();
  const t = norm(target);
  const candidates = [
    ...doc.querySelectorAll<HTMLElement>(
      '[aria-label], [aria-labelledby], [role="region"], [role="group"], [role="tabpanel"], section, aside, main, fieldset',
    ),
  ].filter(isVisible);
  if (candidates.length === 0) return null;

  const exactLabel = candidates.filter((e) => norm(e.getAttribute("aria-label") ?? "") === t);
  if (exactLabel.length > 0) return deepest(exactLabel);

  const byLabelledby = candidates.filter((e) => {
    const id = e.getAttribute("aria-labelledby");
    if (!id) return false;
    const ref = doc.getElementById(id);
    return !!ref && norm(visibleTextOf(ref)) === t;
  });
  if (byLabelledby.length > 0) return deepest(byLabelledby);

  const byHeading = candidates.filter((e) =>
    [...e.querySelectorAll("h1, h2, h3, h4, h5, h6")].some((x) => norm(visibleTextOf(x)) === t),
  );
  if (byHeading.length > 0) {
    return byHeading.reduce((a, b) =>
      visibleTextOf(b).length > visibleTextOf(a).length ? b : a,
    );
  }

  const byTitle = candidates.find((e) =>
    norm(e.getAttribute("title") ?? "").includes(t),
  );
  if (byTitle) return byTitle;

  return findRegionLoosely(doc, t, candidates);
}

/**
 * 区域名的宽松匹配 —— 前面几档都要求**全字相等**,而区域名是描述性的,
 * 写测试的人几乎一定会带上「列表」「区域」「标签」这类后缀:
 * 界面上的标题是「待审批」,她写「待审批列表」;是「筛选」,她写「筛选标签」。
 * 指的是同一个东西,却在全字相等这一关上一律判死。
 *
 * 所以最后补一档:目标名与区域名互为子串即可命中。
 *
 * 但**只在唯一命中时才认**。区域断言的全部价值就在于「限定在哪个区域内」——
 * 「已完成」和「已完成任务」是两个不同的列时,含糊地挑一个等于把这条断言的
 * 意义抽掉,还会静默通过。宁可如实报找不到,让人去看清楚。
 */
function findRegionLoosely(
  doc: Document,
  t: string,
  candidates: HTMLElement[],
): HTMLElement | null {
  const norm = (s: string) => s.replace(/\s+/g, "").trim();
  const related = (name: string) =>
    name.length > 0 && (name.includes(t) || t.includes(name));

  const hits = candidates.filter((e) => {
    const label = norm(e.getAttribute("aria-label") ?? "");
    if (label) return related(label);
    const h = e.querySelector("h1, h2, h3, h4, h5, h6");
    return h ? related(norm(visibleTextOf(h))) : false;
  });
  if (hits.length === 0) return null;

  // 同一个区域会被外层容器重复命中(section 与包着它的 main 标题相同),
  // 那不算歧义;真正的歧义是命中了**互不包含**的两个区域。
  const distinct = hits.filter((a) => !hits.some((b) => b !== a && a.contains(b)));
  return distinct.length === 1 ? distinct[0] : null;
}

/**
 * React 用原型上的 value setter 追踪变更,直接赋值不会触发 onChange。
 * 必须走原生 setter 再派发 input 事件,否则受控组件的状态不会更新 ——
 * 表现就是「填了但没生效」,会被误判成应用的 bug。
 */
function setNativeValue(win: DOMWindow, el: HTMLElement, value: string) {
  // 高层验收描述使用用户看见的 option 文案，而不是实现内部 id/value。
  // 若传入值不是现有 option.value，就尝试按可见标签精确选择。
  const effectiveValue = el.tagName === "SELECT"
    ? selectValueForLabel(el as HTMLSelectElement, value)
    : value;
  const proto =
    el.tagName === "TEXTAREA"
      ? win.HTMLTextAreaElement.prototype
      : el.tagName === "SELECT"
        ? win.HTMLSelectElement.prototype
        : win.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, effectiveValue);
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
}

function selectValueForLabel(select: HTMLSelectElement, requested: string): string {
  if ([...select.options].some((option) => option.value === requested)) return requested;
  const normalized = normalizeText(requested);
  const byLabel = [...select.options].find(
    (option) => normalizeText(option.textContent ?? option.label) === normalized,
  );
  return byLabel?.value ?? requested;
}

function deepest(els: HTMLElement[]): HTMLElement {
  return els.reduce((a, b) => (depth(b) > depth(a) ? b : a));
}
function depth(el: Element): number {
  let d = 0;
  let p: Element | null = el;
  while ((p = p.parentElement)) d++;
  return d;
}

/**
 * 可见性判定 —— 检查自身与所有祖先的显式隐藏状态。
 * jsdom 不做布局,只能靠语义/可访问性状态判断:hidden 属性、inert 属性、
 * aria-hidden="true",以及内联样式里精确的 display:none 与 visibility:hidden。
 * 祖先隐藏则后代必然不可见,所以必须逐层向上查。
 *
 * 关键陷阱:CSS 属性名要按「完整属性」匹配,不能把 backfaceVisibility(3D
 * 翻转背面的隐藏)误当成 visibility:hidden —— 翻转卡片正反两面都会用
 * backface-visibility 隐藏背面,误判会错误地认为整个面都不可见,产生假失败。
 */
export function isVisible(el: HTMLElement): boolean {
  for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
    // 脚本/样式/模板源码不是用户可见内容。jsdom 没有为这些元素提供可靠的
    // 布局可见性，若不显式排除，expectText 会从 bundle 源码字符串里假通过，
    // expectNoText 也会因为脚本里写过某句文案而假失败。
    if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(cur.tagName)) return false;
    if (cur.hasAttribute("hidden")) return false;
    if (cur.hasAttribute("inert")) return false;
    const aria = cur.getAttribute("aria-hidden");
    if (aria && aria.trim().toLowerCase() === "true") return false;
    const style = cur.getAttribute("style") ?? "";
    // 属性名必须是独立的 display / visibility,前面不能连着字母(如 backfaceVisibility)
    if (/(^|[;{\s])display\s*:\s*none/i.test(style)) return false;
    if (/(^|[;{\s])visibility\s*:\s*hidden/i.test(style)) return false;
  }
  return true;
}

/**
 * 只拼接**可见叶子**的文本 —— 折叠面、翻转背面等 aria-hidden/hidden 子树
 * 里的文字不算可见,不参与 expectText / expectNoText,避免把隐藏面当成可见内容。
 */
export function visibleTextOf(el: Element): string {
  let out = "";
  const stack: Node[] = [el];
  while (stack.length) {
    const node = stack.pop()!;
    // nodeType 用数字字面量(1=ELEMENT_NODE, 3=TEXT_NODE):jsdom 的 Node 常量
    // 挂在 window 上,Node 进程内没有全局 Node,直接用字面量避免 ReferenceError。
    if (node.nodeType === 1) {
      const e = node as HTMLElement;
      if (!isVisible(e)) continue;
      for (let i = e.childNodes.length - 1; i >= 0; i--) stack.push(e.childNodes[i]);
    } else if (node.nodeType === 3) {
      out += node.textContent ?? "";
    }
  }
  return out;
}

function textOf(doc: Document): string {
  return normalizeText(visibleTextOf(doc.getElementById("root") ?? doc.body));
}

/**
 * 失败签名 —— 同一组用例在同一位置、报同样的错,判定为「修复后原样复现」。
 * 排序保证与失败出现的顺序无关;是判定基础设施问题的确定性证据。
 */
export function failureSignature(failures: TestFailure[]): string {
  return failures
    .map((f) => `${f.case}#${f.stepIndex}#${f.message}`)
    .sort()
    .join("\n");
}

/** 页面文字和模型写下的期望文字必须用同一套规则比较。 */
function normalizeText(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

/**
 * 从文本里提取**独立的数值 token**,再转成 number。
 * 与 expectText 的子串匹配刻意不同:「12」不能因为子串命中「2」就算通过,
 * 数值断言必须整体相等 —— 这正是 expectNumberWithin 比 expectText 严格的地方。
 *
 * token 支持:
 *  - 负号(如 "-1",不能把 -1 拆成 1);
 *  - 千分位逗号(如 "1,234")与小数(如 "1,234.5")。
 * 匹配后去掉逗号再 Number(),保证 -1 ≠ 1、1,234 ≠ 1、1,234.5 ≠ 1.5。
 */
function extractNumbers(text: string): number[] {
  return [...text.matchAll(/-?\d+(,\d{3})*(\.\d+)?/g)].map((m) =>
    Number(m[0].replace(/,/g, "")),
  );
}

/** 失败时把页面上可操作的东西列出来,让模型知道当前到底渲染成了什么样 */
function describeVisible(doc: Document): string {
  const labels = [
    ...doc.querySelectorAll<HTMLElement>('button, a, [role="button"]'),
  ]
    .filter(isVisible)
    .map((e) => visibleTextOf(e).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 15);
  const inputs = [...doc.querySelectorAll<HTMLElement>("input, textarea")]
    .filter(isVisible)
    .map((e) => e.getAttribute("placeholder") || e.getAttribute("name") || "(无占位符)")
    .slice(0, 8);
  const body = visibleTextOf(doc.getElementById("root") ?? doc.body)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  return `可点击:[${labels.join(" | ")}] 输入框:[${inputs.join(" | ")}] 页面文字:${body}`;
}

async function waitFor(pred: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ASSERT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(200);
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* --------------------------- 可控时钟 --------------------------- */

interface FakeTimer {
  id: number;
  cb: (...args: unknown[]) => void;
  args: unknown[];
  at: number;
  period: number | null;
  active: boolean;
}

interface FakeClock {
  now: number;
  nextId: number;
  timers: FakeTimer[];
}

/** 每个 jsdom 实例一块独立时钟,互相不串 */
const clocks = new WeakMap<DOMWindow, FakeClock>();

function getClock(win: DOMWindow): FakeClock {
  let c = clocks.get(win);
  if (!c) {
    c = { now: 0, nextId: 1, timers: [] };
    clocks.set(win, c);
  }
  return c;
}

/**
 * 用可控时钟接管 window 的 setInterval / setTimeout。
 *
 * jsdom 的定时器走真实事件循环,没法凭空快进;而验收一个倒计时/轮询功能又
 * 必须让它真的走到终态(如 25 分钟专注结束)。所以把窗口里的定时器全部换成
 * 可推进的假定时器:正常操作期间一个都不跑(确定性),advanceTime 一步推进
 * 毫秒数,到期回调按时间顺序同步触发。React 的渲染调度走 MessageChannel /
 * setTimeout(0),由 advanceFakeTime 里的让出循环落定。
 */
function installFakeClock(win: DOMWindow) {
  const clock = getClock(win);
  const originalSetTimeout = win.setTimeout.bind(win);
  const originalClearTimeout = win.clearTimeout.bind(win);
  const schedule = (
    cb: (...args: unknown[]) => void,
    delay: number,
    period: number | null,
    args: unknown[],
  ): number => {
    const id = clock.nextId++;
    clock.timers.push({
      id,
      cb,
      args,
      at: clock.now + Math.max(0, delay || 0),
      period,
      active: true,
    });
    return id;
  };
  const cancel = (id: number) => {
    const t = clock.timers.find((x) => x.id === id);
    if (t) t.active = false;
  };
  win.setInterval = ((cb: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    schedule(cb, delay ?? 0, delay ?? 0, args)) as typeof win.setInterval;
  // 只接管 delay > 0 的 setTimeout。jsdom 没有 MessageChannel,React 的渲染调度
  // 走真实 setTimeout(0) —— 若连它也抓进假时钟,首屏就永远渲染不出来。
  win.setTimeout = ((cb: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    (delay ?? 0) <= 0
      ? originalSetTimeout(cb, delay ?? 0, ...args)
      : schedule(cb, delay ?? 0, null, args)) as typeof win.setTimeout;
  win.clearTimeout = ((id?: number) => {
    if (id != null) cancel(id);
    originalClearTimeout(id);
  }) as typeof win.clearTimeout;
  win.clearInterval = ((id?: number) => {
    if (id != null) cancel(id);
  }) as typeof win.clearInterval;
}

/** 同步按时间顺序触发所有 at <= until 的定时器;period 定时器顺延到下一周期 */
function fireDueSynchronously(clock: FakeClock, until: number): number {
  let fired = 0;
  let guard = 0;
  for (;;) {
    let next: FakeTimer | null = null;
    for (const t of clock.timers) {
      if (!t.active || t.at > until) continue;
      if (!next || t.at < next.at) next = t;
    }
    if (!next) break;
    if (++guard > 200_000) break;
    clock.now = next.at;
    const { cb, args, period } = next;
    if (period != null && period > 0) next.at += period;
    else next.active = false;
    cb(...args);
    fired++;
  }
  return fired;
}

/**
 * 把可控时钟向前推进 ms 毫秒,并让 React 的提交/effect 与异步数据落地。
 *
 * 先同步触发所有到期定时器(倒计时通常一次性把 1500 个 tick 走完,React 批量
 * 合并成最终渲染);再轮流让出真实事件循环并排空 0ms 假定时器 —— 这样
 * effect 驱动的状态流转(倒计时归零 → 完成态 → 计数 +1)也会反映到 DOM。
 */
async function advanceFakeTime(win: DOMWindow, ms: number) {
  const clock = getClock(win);
  const target = clock.now + Math.max(0, ms);
  fireDueSynchronously(clock, target);
  clock.now = Math.max(clock.now, target);
  for (let i = 0; i < 10; i++) {
    await sleep(0);
    const n = fireDueSynchronously(clock, clock.now);
    if (n === 0) break;
  }
}

/* --------------------------- 数据层直连 --------------------------- */

/**
 * 把生成物发出的 fetch 直接接到数据服务上。
 *
 * 不走 HTTP:测试跑在服务端进程内,自己请求自己既慢又需要知道自己的地址
 * (Serverless 环境下这件事并不总是可靠)。直接调同一份实现更稳,
 * 也保证了测试环境与生产环境用的是同一套读写逻辑。
 */
function installDataShim(
  window: DOMWindow,
  isolatedRunId: string,
  touchedCollections: Set<string>,
) {
  (window as unknown as { fetch: unknown }).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = parseAppDataUrl(url);
    if (!parsed) {
      // 生成物不该请求别的东西;真请求了就明确拒绝,而不是静默放行
      return new Response(JSON.stringify({ error: "测试环境不允许外部请求" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    touchedCollections.add(parsed.collection);
    const method = ((init?.method ?? "GET").toUpperCase() as AppDataMethod) ?? "GET";
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = {};
      }
    }
    // 永远覆盖生成物 URL 里的真实 runId。测试可以使用与生产完全相同的
    // 数据 API,但绝不能读写用户打开应用时会看到的真实数据空间。
    const result = await handleAppData(isolatedRunId, parsed.collection, method, body);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** 测完立即清理隔离空间,避免本地文件存储或线上数据库累积 QA 垃圾数据。 */
async function cleanupTestData(runId: string, collections: Set<string>) {
  for (const collection of collections) {
    const listed = await handleAppData(runId, collection, "GET", undefined);
    if (!Array.isArray(listed.body)) continue;
    for (const row of listed.body) {
      if (typeof row.id === "string") {
        await handleAppData(runId, collection, "DELETE", { id: row.id });
      }
    }
  }
}
