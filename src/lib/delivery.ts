/**
 * 交付证据采集 —— 给产品负责人验收用的客观材料。
 *
 * 为什么不能让 Ida 只读源码下结论:那又变回「自我汇报」了。
 * 模型看着自己团队写的代码说「视觉挺好的」仍然缺少外部依据。
 *
 * 所以这里从**已构建的真实产物**里确定性地提取证据:
 *   视觉 —— 编译后的 CSS 里真实用到的色板、字号阶梯、圆角、间距
 *   结构 —— 真实渲染的 DOM 里的标题层级、控件与其可读标签、空态引导
 *   硬伤 —— 无障碍/可用性上不需要讨论的问题(没有可读标签的按钮等)
 *
 * 其中「硬伤」是**不调用模型**就能判定的,直接作为客观缺陷回喂;
 * 模型只负责真正主观的那部分:这套视觉配不配得上目标人群、
 * 这个流程符不符合人的使用习惯。把能确定的先确定下来,
 * 剩下的才交给判断 —— 这是整个项目一以贯之的做法。
 */

import { JSDOM, VirtualConsole, type DOMWindow } from "jsdom";
import { handleAppData, parseAppDataUrl, type AppDataMethod } from "./appdata";
import { isVisible, visibleTextOf } from "./testrunner";

export interface DeliveryEvidence {
  /** CSS 里真实出现的颜色(按出现次数降序),反映实际色板而非声称的色板 */
  palette: string[];
  /** 字号阶梯 —— 层级是否清晰的客观依据 */
  fontSizes: string[];
  /** 圆角取值 —— 风格一致性的信号 */
  radii: string[];
  cssBytes: number;

  /** 标题层级(h1-h3),信息架构是否清楚 */
  headings: { level: number; text: string }[];
  /** 可点击控件的可见文案 */
  buttons: string[];
  /** 输入控件的提示文案 */
  inputs: string[];
  /** 首屏可见文字 —— 初次打开时用户实际看到什么 */
  visibleText: string;
  nodeCount: number;

  /**
   * 不需要讨论的客观缺陷。这些直接进 issues,不占用模型的判断额度。
   */
  hardIssues: string[];

  /**
   * 有标题、但底下只有一句占位文案的区块。
   *
   * 实测:一个咖啡品牌页通过了全部质量门,交付出去「豆单」却是
   * 「豆单还在整理中,稍后再来看看。」—— 功能没坏,但这个产品核心的那一屏是空的。
   *
   * 刻意只作为**证据**交给 Ida,不当硬伤:空态本身没有错。
   * 待办清单第一次打开当然是空的,那是在等用户输入;
   * 而品牌页的商品列表是这个产品自己该有的内容,空着就是没做完。
   * 这个区别需要结合产品形态判断,正是该由她来定的那类事。
   */
  emptySections: string[];
}

const MAX_LIST = 14;

/**
 * 在真实渲染的页面上采证。
 * 用的是与 Tess 验收完全相同的渲染路径(同一份 HTML、同一个数据服务),
 * 所以「验收看到的」和「用户打开看到的」是同一个东西。
 */
export async function collectDeliveryEvidence(
  html: string,
  css: string,
  runId: string,
): Promise<DeliveryEvidence> {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  const dom = new JSDOM(html, {
    url: `http://vibeu.local/a/${runId}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      installDataBridge(window, runId);
    },
  });

  try {
    // 等首屏挂载与初次数据加载 —— 与 Tess 的等待口径保持一致
    await new Promise((r) => setTimeout(r, 1600));
    const doc = dom.window.document;
    const root = doc.getElementById("root");

    const headings = [...doc.querySelectorAll<HTMLElement>("h1, h2, h3")]
      .filter(isVisible)
      .map((h) => ({
        level: Number(h.tagName[1]),
        text: visibleTextOf(h).slice(0, 60),
      }))
      .filter((h) => h.text.length > 0)
      .slice(0, MAX_LIST);

    const clickables = [
      ...doc.querySelectorAll<HTMLElement>('button, a, [role="button"]'),
    ].filter(isVisible);

    const buttons = clickables
      .map((b) => visibleTextOf(b).trim())
      .filter(Boolean)
      .slice(0, MAX_LIST);

    const inputEls = [
      ...doc.querySelectorAll<HTMLElement>("input, textarea, select"),
    ].filter(isVisible);

    const inputs = inputEls
      .map(
        (el) =>
          el.getAttribute("placeholder") ||
          el.getAttribute("aria-label") ||
          labelTextFor(doc, el) ||
          "",
      )
      .filter(Boolean)
      .slice(0, MAX_LIST);

    const visibleText = root ? visibleTextOf(root).slice(0, 900) : "";

    const styleFacts = extractStyleFacts(css);
    const cssBytes = Buffer.byteLength(css, "utf8");
    const hardIssues = findHardIssues({
      clickables,
      inputEls,
      doc,
      headings,
      visibleText,
    });
    hardIssues.unshift(...styleEvidenceIssues(css, styleFacts));

    return {
      ...styleFacts,
      cssBytes,
      headings,
      buttons,
      inputs,
      visibleText,
      nodeCount: root ? root.querySelectorAll("*").length : 0,
      emptySections: findEmptySections(doc),
      hardIssues,
    };
  } finally {
    dom.window.close();
  }
}

/** 视觉证据不足不是“主观上还行”，而是平台无法证明样式真的进入了交付物。 */
export function styleEvidenceIssues(
  css: string,
  facts = extractStyleFacts(css),
): string[] {
  const issues: string[] = [];
  if (!css.trim()) issues.push("构建产物没有任何业务 CSS，页面会退化为浏览器默认样式");
  if (facts.palette.length === 0) issues.push("编译后 CSS 未采到任何颜色，无法验证视觉方案的色板");
  if (facts.fontSizes.length === 0) issues.push("编译后 CSS 未采到任何字号，无法验证信息层级");
  return issues;
}

/**
 * 首屏控件清单 —— 交给 Tess 写测试计划时看的「实际界面」。
 *
 * 跑 20 场景时最贵的一课:她只看得到源码,看不到界面,于是她在**猜**控件叫什么。
 * 猜错了就写出定位不到的步骤,失败后责任被归给 Cody,而 Cody 只能反过来猜
 * 她想要什么名字 —— 两边互猜,三轮修复全部落空。
 *
 * 更糟的是源码里「有这个字符串」并不代表「界面上能定位到」:
 * `aria-label="输入书名"` 确实写在源码里,但它在一个还没打开的弹窗组件里,
 * 首屏根本没有。所以纯文本检查救不了这一类,必须真的渲染一次去看。
 *
 * 这里按**执行器完全相同的定位规则**解析名称并列出来。给她看真实的名字,
 * 比给她加任何一条"请不要编造"的规则都有效 —— 前者消除猜测,后者只是请求她别猜。
 */
export interface ScreenNames {
  /** 可点击控件:可见文字优先,没有文字则用 aria-label/title */
  clickables: string[];
  /** 输入框:placeholder / aria-label / 关联 label 文字 */
  inputs: string[];
  /** 区域容器的可访问名 —— expectTextWithin 只能用这些 */
  regions: string[];
  headings: string[];
}

export interface ScreenInventory extends ScreenNames {
  /**
   * 点开新建入口之后才出现的控件 —— 表单字段几乎都在这一层。
   *
   * 只采首屏是不够的:notes 里「输入书名」在弹窗组件里,首屏一个输入框都没有,
   * Tess 照着源码把 fill 写成第 1 步,必然失败。她需要知道的是
   * 「这些字段存在,但要先点『新书入架』」。
   */
  afterOpen?: { via: string } & ScreenNames;
  /**
   * 造出一条记录之后才出现的控件 —— 每条记录自己的操作按钮在这一层。
   *
   * crm 里她反复写「赵六 设为已成交」,而那个按钮长什么样、叫什么,
   * 在没有任何客户的首屏上根本无从得知。不给她看,她就只能继续编。
   */
  afterCreate?: { via: string } & ScreenNames;
}

/** 新建入口 / 提交按钮的识别词 —— 命中不了就跳过该层,不猜也不报错 */
const CREATE_HINT = /新增|添加|新建|录入|创建|申请|写下|记一笔|记收入|记支出|记账|\+/;
const SUBMIT_HINT = /保存|提交|确定|确认|添加|新增|新建|录入|入架|入库|创建|记一笔/;

export async function collectScreenInventory(
  html: string,
  runId: string,
): Promise<ScreenInventory> {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  /**
   * 探查会真的填表、真的点提交,于是会真的写数据。
   * 必须写进一个一次性命名空间 —— 否则交付给用户的应用里会躺着
   * 「探查样例」这种垃圾记录,而且下一次探查还会把它当成首屏本来就有的内容。
   */
  const probeId = `${runId}__probe__${Date.now().toString(36)}`;

  const dom = new JSDOM(html, {
    url: `http://vibeu.local/a/${probeId}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      installDataBridge(window, probeId, true);
    },
  });

  try {
    await new Promise((r) => setTimeout(r, 1600));
    const win = dom.window;
    const doc = win.document;
    const settle = () => new Promise((r) => setTimeout(r, 500));

    const first = readNames(doc);

    /**
     * 往里走两步。每一步都是**尽力而为**:识别不到入口就跳过这一层,
     * 少给几个名字远好过给错名字或让整条流水线挂掉。
     */
    let afterCreate: ({ via: string } & ScreenNames) | undefined;

    // 总是试着打开新增表单。判据只能是「输入框真的变多」——
    // 用「首屏没有输入框」当判据会漏掉 crm 这种首屏带搜索框的:表单明明在弹窗里,
    // 却因为首屏已经有一个搜索框而跳过整层探查,反而在搜索框上瞎填一通。
    // 探不到就说明表单本来就摊在首屏上(内联新增),那时 first 自己就是表单层。
    const afterOpen = await openForm(doc, first, settle);

    const formLayer = afterOpen ?? { via: "首屏表单", ...first };
    if (formLayer.inputs.length > 0) {
      afterCreate = await createRecord(win, doc, first, formLayer, settle);
    }

    return { ...first, afterOpen, afterCreate };
  } finally {
    dom.window.close();
  }
}

/** 采一层界面的可用名称,取法与执行器的定位规则严格同源 */
function readNames(doc: Document): ScreenNames {
  const uniq = (xs: string[]) =>
    [...new Set(xs.map((x) => x.trim()).filter(Boolean))].slice(0, 40);

  const clickables = uniq(clickableEls(doc).map(nameOf));

  // 执行器按 placeholder / aria-label / 关联 label / name / id 中任一种定位字段。
  // 探查也必须保留全部合法别名，不能只取第一个：一个 textarea 同时有 placeholder
  // 「记录本周完成…」和 label「本周完成」时，两者都能被 findInput 找到。只上报
  // placeholder 会让 value-target 门把合法的 expectValue("本周完成") 误判成只读区域。
  const inputs = uniq(
    [...doc.querySelectorAll<HTMLElement>("input, textarea, select")]
      .filter(isVisible)
      .flatMap((el) => [
        el.getAttribute("placeholder") || "",
        el.getAttribute("aria-label") || "",
        labelTextFor(doc, el) || "",
        el.getAttribute("name") || "",
        el.getAttribute("id") || "",
      ]),
  );

  // 与 findRegion 同源:aria-label 或内部标题才构成区域名
  const regions = uniq(
    [
      ...doc.querySelectorAll<HTMLElement>(
        '[aria-label], [role="region"], [role="group"], [role="tabpanel"], section, aside, main, fieldset',
      ),
    ]
      .filter(isVisible)
      .flatMap((e) => {
        const label = e.getAttribute("aria-label");
        if (label) return [label];
        const h = e.querySelector("h1, h2, h3, h4, h5, h6");
        return h ? [visibleTextOf(h).trim()] : [];
      }),
  );

  const headings = uniq(
    [...doc.querySelectorAll<HTMLElement>("h1, h2, h3")]
      .filter(isVisible)
      .map((h) => visibleTextOf(h).trim()),
  );

  return { clickables, inputs, regions, headings };
}

/** 与 findClickable 同源的候选集合 */
function clickableEls(doc: Document): HTMLElement[] {
  return [
    ...doc.querySelectorAll<HTMLElement>(
      'button, a, [role="button"], input[type="submit"], label, li',
    ),
  ].filter(isVisible);
}

function nameOf(e: HTMLElement): string {
  return (
    visibleTextOf(e).trim() ||
    e.getAttribute("aria-label") ||
    e.getAttribute("title") ||
    ""
  );
}

/**
 * 打开新增表单 —— 判据是**点完之后真的多了输入框**,不是按钮名字像不像新增。
 *
 * 一开始用关键词表找入口,notes 的按钮叫「新书入架」,一个词都没命中,
 * 于是探不到第 2 层。靠词表猜按钮名,正是这套探查本来要消灭的那种猜测。
 * 关键词只用来决定**先试谁**,真正说了算的是点完之后界面有没有变。
 */
async function openForm(
  doc: Document,
  first: ScreenNames,
  settle: () => Promise<unknown>,
): Promise<({ via: string } & ScreenNames) | undefined> {
  const candidates = clickableEls(doc)
    .filter((e) => nameOf(e).length > 0 && nameOf(e).length <= 12)
    .sort(
      (a, b) =>
        Number(CREATE_HINT.test(nameOf(b))) - Number(CREATE_HINT.test(nameOf(a))) ||
        nameOf(a).length - nameOf(b).length,
    )
    .slice(0, 4);

  for (const el of candidates) {
    const via = nameOf(el);
    el.click();
    await settle();
    const opened = readNames(doc);
    if (opened.inputs.length > first.inputs.length) return { via, ...opened };
  }
  return undefined;
}

/**
 * 造一条真实记录 —— 只有有了记录,每条记录自己的操作按钮才会存在,
 * 而那正是 Tess 反复编错的地方(「赵六 设为已成交」)。
 *
 * 提交按钮只在**这一层新出现的控件**里找:crm 的入口叫「新增客户」,
 * 表单里的提交叫「保存客户」,按名字长度挑会挑回入口本身,记录根本没创建,
 * 却报出一个看起来煞有介事的第 3 层。
 */
async function createRecord(
  win: DOMWindow,
  doc: Document,
  first: ScreenNames,
  form: { via: string } & ScreenNames,
  settle: () => Promise<unknown>,
): Promise<({ via: string } & ScreenNames) | undefined> {
  if (fillAll(win, doc) === 0) return undefined;

  // 找提交按钮:它是**表单打开后**才出现的,所以只排除首屏就有的名字。
  // crm 的入口叫「新增客户」、表单里的提交叫「保存客户」,不排除首屏的话
  // 会挑回入口本身,记录根本没建成。
  const onFirstScreen = new Set(first.clickables);
  const fresh = clickableEls(doc).filter(
    (e) =>
      nameOf(e).length > 0 && nameOf(e).length <= 12 && !onFirstScreen.has(nameOf(e)),
  );
  const pool = fresh.length > 0 ? fresh : clickableEls(doc);
  const submit = pool
    .filter((e) => SUBMIT_HINT.test(nameOf(e)))
    .sort((a, b) => nameOf(a).length - nameOf(b).length)[0];
  if (!submit) return undefined;

  const submitVia = nameOf(submit);
  submit.click();
  await settle();
  await settle();

  const created = readNames(doc);
  // 记录真的出现了才算数,基准必须是**表单这一层**:拿首屏比的话,
  // 弹窗自己的「关闭/取消/保存客户」都算新增,于是提交明明失败、弹窗还开着,
  // 却报出一个看起来像模像样的第 3 层,把 Tess 引向一批不存在的控件。
  const seen = new Set([...first.clickables, ...form.clickables]);
  if (created.clickables.every((n) => seen.has(n))) return undefined;
  return { via: `${form.via} → 填写后点「${submitVia}」`, ...created };
}

/**
 * 给每个可见输入框填一个像样的值。
 *
 * 必须走原生 setter 再派发事件 —— React 用原型上的 value setter 追踪变更,
 * 直接赋值不会触发 onChange,表现就是「填了但没生效」。这个坑执行器里踩过一次,
 * 这里是同一份处理。
 */
function fillAll(win: DOMWindow, doc: Document): number {
  const els = [
    ...doc.querySelectorAll<HTMLElement>("input, textarea, select"),
  ].filter(isVisible);
  let n = 0;
  for (const el of els) {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (["checkbox", "radio", "file", "submit", "button"].includes(type)) continue;

    if (el.tagName === "SELECT") {
      const opt = el.querySelector("option[value]:not([value=''])");
      if (!opt) continue;
      setNative(win, el, opt.getAttribute("value") ?? "");
      n++;
      continue;
    }

    const value =
      type === "number"
        ? "1"
        : type === "date"
          ? new Date().toISOString().slice(0, 10)
          : "探查样例";
    setNative(win, el, value);
    n++;
  }
  return n;
}

function setNative(win: DOMWindow, el: HTMLElement, value: string) {
  const proto =
    el.tagName === "TEXTAREA"
      ? win.HTMLTextAreaElement.prototype
      : el.tagName === "SELECT"
        ? win.HTMLSelectElement.prototype
        : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
}

/**
 * 找出「有标题、底下却几乎没内容」的区块。
 *
 * 判据保持保守:标题之后的正文短到只可能是一句占位文案,且不含任何
 * 列表项/卡片/控件。宁可漏报 —— 这条是交给人判断的证据,不是硬伤,
 * 误报会让 Ida 把注意力浪费在本来就该空的空态上。
 */
function findEmptySections(doc: Document): string[] {
  const out: string[] = [];
  for (const h of doc.querySelectorAll<HTMLElement>("h2, h3")) {
    if (!isVisible(h)) continue;
    const section = h.closest("section, article, div");
    if (!section) continue;

    const title = visibleTextOf(h).trim();
    const body = visibleTextOf(section).replace(title, "").trim();
    if (title.length === 0) continue;
    // 有真正的内容承载物就不算空
    if (section.querySelector("li, table, img, input, textarea, form")) continue;
    // 正文长到不像一句占位话,也不算空
    if (body.length === 0 || body.length > 40) continue;

    out.push(`${title} —— 整块内容只有「${body.slice(0, 28)}」`);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * 客观缺陷 —— 这些不需要模型判断,也不该占用它的注意力。
 * 每一条都是「无论什么产品、什么人群都成立」的问题。
 */
function findHardIssues(ctx: {
  clickables: HTMLElement[];
  inputEls: HTMLElement[];
  doc: Document;
  headings: { level: number; text: string }[];
  visibleText: string;
}): string[] {
  const issues: string[] = [];

  const unlabeled = ctx.clickables.filter(
    (b) =>
      visibleTextOf(b).trim().length === 0 &&
      !b.getAttribute("aria-label") &&
      !b.getAttribute("title"),
  );
  if (unlabeled.length > 0) {
    issues.push(
      `有 ${unlabeled.length} 个可点击元素既没有可见文字也没有 aria-label/title,` +
        `用户和读屏软件都无从知道它是干什么的`,
    );
  }

  const namelessInputs = ctx.inputEls.filter(
    (el) =>
      !el.getAttribute("placeholder") &&
      !el.getAttribute("aria-label") &&
      !labelTextFor(ctx.doc, el),
  );
  if (namelessInputs.length > 0) {
    issues.push(
      `有 ${namelessInputs.length} 个输入框没有任何提示(无 placeholder / aria-label / label),` +
        `用户不知道该填什么`,
    );
  }

  if (ctx.headings.length === 0) {
    issues.push("页面没有任何标题元素(h1/h2/h3),信息层级不清楚");
  }

  if (ctx.visibleText.trim().length < 12) {
    issues.push("首屏几乎没有可见文字,用户打开后不知道这是什么、该做什么");
  }

  return issues;
}

/** 从编译后的 CSS 里提取真实用到的视觉参数 */
function extractStyleFacts(css: string): {
  palette: string[];
  fontSizes: string[];
  radii: string[];
} {
  const colorRe =
    /(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)|oklch\([^)]+\)|hsla?\([^)]+\))/g;
  const palette = topBy(css.match(colorRe) ?? [], MAX_LIST);

  const fontSizes = uniqueSorted(
    (css.match(/font-size:\s*([^;}]+)/g) ?? []).map((m) =>
      m.replace(/font-size:\s*/, "").trim(),
    ),
  ).slice(0, MAX_LIST);

  const radii = uniqueSorted(
    (css.match(/border-radius:\s*([^;}]+)/g) ?? []).map((m) =>
      m.replace(/border-radius:\s*/, "").trim(),
    ),
  ).slice(0, 8);

  return { palette, fontSizes, radii };
}

/** 按出现频次取前 n 个 —— 频次高的才是主色,而不是随便某处出现过一次的颜色 */
function topBy(values: string[], n: number): string[] {
  const count = new Map<string, number>();
  for (const v of values) {
    const k = v.trim().toLowerCase();
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, c]) => `${k}×${c}`);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()))].sort();
}

function labelTextFor(doc: Document, el: HTMLElement): string {
  const id = el.getAttribute("id");
  if (id) {
    // 遍历比较而不是拼选择器:CSS.escape 是浏览器全局,服务端采证时不存在;
    // 而且 id 里若带特殊字符,未转义的选择器会直接抛错。
    for (const lb of doc.querySelectorAll("label")) {
      if (lb.getAttribute("for") === id) return visibleTextOf(lb).trim();
    }
  }
  const wrapper = el.closest("label");
  return wrapper ? visibleTextOf(wrapper).trim() : "";
}

/**
 * 与测试执行器同样的做法:把生成物的 fetch 直接接到数据服务上。
 * 不走 HTTP —— 采证跑在服务端进程内,自己请求自己既慢又需要知道自己的地址。
 */
function installDataBridge(window: unknown, runId: string, force = false) {
  (window as { fetch: unknown }).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = parseAppDataUrl(url);
    if (!parsed) {
      return new Response(JSON.stringify({ error: "采证环境不允许外部请求" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    const method = ((init?.method ?? "GET").toUpperCase() as AppDataMethod) ?? "GET";
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = {};
      }
    }
    const result = await handleAppData(
      // force 时无条件用传进来的命名空间。界面探查会真的填表、真的提交,
      // 而生成物里的 runId 是构建期注入的**真实** runId —— 顺着它写下去,
      // 交付给用户的应用里就会躺着「探查样例」这种垃圾记录。
      force ? runId : parsed.runId || runId,
      parsed.collection,
      method,
      body,
    );
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}
