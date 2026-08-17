/**
 * 场景压力覆盖护栏 —— 判定 Tess 写的验收用例是否真的碰到了该场景的难点。
 *
 * 常见假阳:QA 全过,但用例只覆盖了「能新建 / 能保存」这类骨架操作,
 * 场景真正难的语义(连续天数、聚合、时间冲突、除零、无第三方库…)根本没被测到。
 * 这里对每个场景维护一组「必须被 QA 文本覆盖」的关键语义正则,合并所有轮次的
 * 用例名与失败原因做匹配。
 *
 * 本模块是 **纯函数**、不依赖 testrunner/orchestrator,供两条链路复用:
 *  1. orchestrator 的 phaseQa —— Tess 产出用例后、真正 runTests 前先做覆盖门,
 *     缺覆盖就发 qa.coverage_retry 回喂 Tess 重写测试计划(前置软门,可迭代);
 *  2. run-scenarios 的 runner —— QA 全过之后、verify/publish 之前做外层硬门,
 *     把「QA 全绿但没测重点」从隐形变显性,作为最后兜底,不再假装已交付。
 *
 * 命中与否记录进结果并在命令行显式标注。
 */

import type { QaStepSnapshot } from "./events";

/** 用例步骤快照 —— 直接用事件模型的 QaStepSnapshot,避免两份形状漂移 */
export type QaStepLike = QaStepSnapshot;

export type QaCaseLike = {
  name: string;
  /** 用例声明覆盖的 PRD P0 功能名；名称逐字来自 PRD。 */
  covers?: string[];
  ok?: boolean;
  reason?: string;
  steps?: QaStepLike[];
};

export type QaHistoryLike = { cases: QaCaseLike[] }[];

/**
 * 每个场景必须被验收用例覆盖到的语义。正则匹配合并后的用例名 + 失败原因。
 * 留空数组 = 无特别难点(基线场景),恒覆盖。
 */
export const GUARDRAILS: Record<string, RegExp[]> = {
  todo: [],
  habit: [/连续|streak|天数|连签/],
  ledger: [/结余|合计|本月|统计|收支/, /收入|正数/, /支出|负数/],
  notes: [/摘录|按书|切(换|到)|选中|书籍|主从/],
  flashcard: [/翻面?|释义|掌握|筛选|全部/],
  recipe: [/步骤|配料|标签|筛选/],
  // workout 是多数值字段 + 按周聚合:三条独立语义(周聚合 / 组数 / 重量)必须逐条命中,
  // 只有用例名喊「本周汇总」、步骤却只保存不触数值,过不了门。
  workout: [/本周|周训练|汇总|合计/, /组数|组/, /重量|kg/],
  // pomodoro 两条独立语义(计时器 / 休息+完成计数)必须逐条命中:只喊「番茄计时」、
  // 不碰休息/完成计数,过不了门。
  pomodoro: [/番茄|计时|倒计时|计时器/, /休息|完成|计数|清零/],
  kanban: [/待办|进行中|已完成|切换|状态|列/],
  crm: [/跟进|备注|成交|详情|列表/],
  inventory: [/库存|低|高亮|增减|边界|0|零/],
  booking: [/冲突|时间段|预订|当天|重叠/],
  leave: [/审批|通过|驳回|历史|状态/],
  poll: [/票|占比|百分比|实时|0|零|除零/],
  expense: [/合计|金额|格式化|总/],
  "sales-dash": [/月|趋势|top|top\s?\d|销售额|商品/],
  "weekly-report": [/导出|复制|剪贴板|文本/],
  mortgage: [/月供|利息|利率|年限/],
  bmi: [/BMI|身高|体重|建议|历史/],
  "coffee-site": [/品牌|介绍|产品|留言/],
};

/**
 * 把历史所有轮次的用例证据合并成一段可匹配文本:
 * 用例名 + 失败原因 + **逐条执行步骤**(action/target/text/value)。
 * 步骤是「用例到底做了什么」的硬证据 —— 只靠名字喊「本周汇总」、步骤里没碰组数/重量,
 * 合并出来的文本就不会命中对应语义,门照样拦得住。
 */
export function qaCaseText(qaHistory: QaHistoryLike): string {
  return qaHistory
    .flatMap((q) => q.cases)
    .map((c) => {
      const stepsText = (c.steps ?? [])
        .map((s) =>
          [s.action, s.target, s.text, s.value, s.ms !== undefined ? `${s.ms}ms` : undefined]
            .filter((x) => x !== undefined)
            .join(" "),
        )
        .join(" ");
      return [c.name, ...(c.covers ?? []), c.reason, stepsText]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join(" ");
    })
    .join("\n");
}

const normalizedFeatureName = (value: string) => value.replace(/\s+/g, "").toLocaleLowerCase();

/**
 * 正常用户链路的 PRD 覆盖门。
 *
 * 场景 guardrail 只能覆盖测试活动中已登记的 20 个固定场景；真实用户输入没有
 * scenarioId。Tess 因此必须为每条用例声明它覆盖的 P0 功能，确定性代码核对
 * 所有 P0 是否至少被一条用例接住。声明本身不能代替操作步骤，但能先堵住
 * 「PRD 有 4 个核心功能、QA 只测了添加/保存就全绿」这一类最常见假阳。
 */
export function featureCoverageMissing(
  requiredFeatures: string[],
  cases: QaCaseLike[],
): string[] {
  const declared = new Set(
    cases.flatMap((c) => c.covers ?? []).map(normalizedFeatureName).filter(Boolean),
  );
  return requiredFeatures
    .filter((name) => !declared.has(normalizedFeatureName(name)))
    .map((name) => `PRD P0 功能「${name}」缺少直接验收用例`);
}

/**
 * 场景的「结构化」额外要求 —— 正则文本覆盖表达不了的证据,必须从步骤本身看。
 * pomodoro:只是用例名/文案喊「计时」不算数,必须真的出现一次
 * advanceTime 推进 ≥1500 秒(25 分钟)的步骤证据,才能证明验证了计时终态。
 * kanban:多列布局的关键是「任务真的落在正确的列」,全页面 expectText 无法证明 ——
 * 任务名全局还在就会假过。必须看到**同一用例内**同一个任务文本的**正向迁移链路**:
 *   1) 先在「进行中任务」expectTextWithin 断言它进入进行中;
 *   2) 两次正向断言之间至少有一次 click(真的发生了迁移);
 *   3) 再在「已完成任务」expectTextWithin 断言它落进已完成;
 *   4) 离开证据:旧「进行中任务」列对该文本有 expectNoTextWithin。
 * 只收集 action===expectTextWithin 的正向证据 —— 两条纯负断言(进行中不应有 / 已完成不应有)
 * 没有证明任何迁移,必须被拒。每条用例从空数据开始,只有同一条用例完整走过链路才算数。
 * crm:只有用例名/文案喊「编辑保存」不算数,必须真的出现一次 expectValue 字段值断言。
 */
export const STRUCTURAL_GATES: Record<
  string,
  { label: string; check: (cases: QaCaseLike[]) => boolean }
> = {
  pomodoro: {
    label: "步骤证据含 advanceTime 推进 ≥1500 秒(25 分钟)",
    check: (cases) =>
      cases
        .flatMap((c) => c.steps ?? [])
        .some(
          (s) => s.action === "advanceTime" && typeof s.ms === "number" && s.ms >= 1_500_000,
        ),
  },
  kanban: {
    label:
      "步骤证据:同一任务文本先在**某一列**内正向断言 → 其间有 click 迁移 → " +
      "在**另一列**内正向断言 → 并对原来那一列有 expectNoTextWithin 离开证据。" +
      "用哪两列不限,列名照界面上真实的写",
    /**
     * 检查的是流转的**形状**,不是特定两列的名字。
     *
     * 原先写死「进行中 → 已完成」。跑批里 Tess 交出的计划是
     *   在「待办列」断言 → click 切换状态 → 在「进行中列」断言 → 对「待办列」离开证据
     * 结构上一条不缺,只是走的是另一对列、列名跟着真实界面叫「待办列」,
     * 于是被连拒两轮、整场作废。这是同一个错误的第三次:
     * 门在检查字面形式,而不是它真正想要的那个语义性质。
     *
     * 真正要证明的只有一句:同一个东西**离开了一列、出现在另一列**,
     * 中间确实发生了操作。至于是哪两列,产品自己说了算。
     */
    check: (cases) => {
      const norm = (s: string) => s.replace(/\s+/g, "").trim();
      for (const c of cases) {
        const steps = c.steps ?? [];
        const positives = steps
          .map((s, i) => ({ s, i }))
          .filter(
            (x): x is { s: QaStepLike & { target: string; text: string }; i: number } =>
              x.s.action === "expectTextWithin" &&
              typeof x.s.target === "string" &&
              typeof x.s.text === "string",
          );

        for (const from of positives) {
          for (const to of positives) {
            const t = norm(from.s.text);
            // 同一个任务文本,先后落在**两个不同的**容器里
            if (t !== norm(to.s.text)) continue;
            if (norm(from.s.target) === norm(to.s.target)) continue;
            if (!(from.i < to.i)) continue;
            // 两次正向断言之间必须有 click —— 没有操作就没有迁移,纯断言不成立
            if (!steps.slice(from.i + 1, to.i).some((b) => b.action === "click")) continue;
            // 离开证据:对**原来那一列**断言该文本已不在,且发生在首次正向断言之后
            const leave = steps.some(
              (s, i) =>
                s.action === "expectNoTextWithin" &&
                norm(s.target ?? "") === norm(from.s.target) &&
                norm(s.text ?? "") === t &&
                i > from.i,
            );
            if (leave) return true;
          }
        }
      }
      return false;
    },
  },
  crm: {
    label:
      "步骤证据:同一用例内先 fill 一段内容,之后真的断言**这段内容本身**还在 —— " +
      "expectValue / expectText / expectTextWithin 哪个都行,关键是断言的文字" +
      "必须是你前面真正填进去的那段,而不是无关的静态文案",
    /**
     * 这道门要的是「编辑真的存住了」,不是「用了某个特定断言动作」。
     *
     * 它把 crm 连杀了七轮,三次都是用**错的理由**杀掉一个**对的测试**:
     *   一版硬要 expectValue —— 把「备注保存后渲染为详情文本」这种完全合理的
     *   实现判死,Tess 按提示词改用 expectTextWithin 反被连拒;
     *   一版加要求走完「保存 → 离开 → 重新进入」—— 她两轮都满足不了,整场跑死;
     *   一版只认 expectValue/expectTextWithin —— 而她写的是
     *     fill 电话沟通报价 → 保存 → expectText → 返回列表 → 点回该客户 → expectText
     *   这是教科书式的持久化验证,连「离开再回来」都做到了,只因为用的是
     *   全页面 expectText 而不是区域断言,又被拒两轮。
     *
     * 每一版都比上一版「更严谨」,每一版都在拿断言的**形式**当证据,
     * 而真正该问的只有一句:填进去的那段内容,后来有没有被断言过还在。
     *
     * 结论两条,都是拿整场生成换来的:
     *   门卡到测试写不出来的程度,代价是整个 run;
     *   更强的证据要求属于提示词里的引导,不该做成硬门。
     *
     * 放宽但不放水:断言的必须是**填进去的那段内容**,断静态文案不算数。
     */
    check: (cases) =>
      cases.some((c) => {
        const steps = c.steps ?? [];
        const norm = (s: string) => s.replace(/\s+/g, "");

        return steps.some((s, i) => {
          // 读回字段当前值本身就是回显证据,不必再比对填过什么
          if (s.action === "expectValue") return true;

          const asserted =
            s.action === "expectText" || s.action === "expectTextWithin"
              ? s.text
              : undefined;
          if (!asserted) return false;

          const text = norm(asserted);
          const fillAt = steps.findIndex(
            (f) =>
              f.action === "fill" &&
              f.value &&
              (text.includes(norm(f.value)) || norm(f.value).includes(text)),
          );
          // 断言的必须是此前某一步填进去的内容
          return fillAt >= 0 && fillAt < i;
        });
      }),
  },
  inventory: {
    label: "步骤证据:同一商品同一用例内,创建商品时 fill「低库存阈值」设定可解析阈值(先于 low 出现)→ 数量断言到 0(先于 low 出现)→ 低库存语义标记出现 → 本商品 click 补货且数量回弹到 >阈值 → 标记消失(同 target 同 attr,顺序+同对象;数值 target 须含度量语义,expectValue 或 expectNumberWithin 均可)",
    check: (cases) => {
      const norm = (s: string) => s.replace(/\s+/g, "").trim();
      /** 数量断言:expectValue 读输入框,expectNumberWithin 读只读 div 数值展示 —— 两者都算数值证据 */
      const isQuantity = (action: string) =>
        action === "expectValue" || action === "expectNumberWithin";
      /** 数值断言必须钉在**具体度量**上(数量/库存/金额/票数…),不能只写整行商品区域 ——
       *  同一行常同时显示「当前库存 2」与「阈值 0」,target=「苹果」会命中阈值造成假过 */
      const hasMeasure = (t: string) => /数量|库存|金额|票数|价格|余额/.test(t);
      for (const c of cases) {
        const steps = c.steps ?? [];
        // 商品名称:从创建商品的 fill 步骤提取(如 fill「商品名称」→「苹果」)。
        // 行 aria-label 是「商品 苹果」、数值 aria-label 是「苹果 当前库存」,规范化后互相都不包含
        // (「商品苹果」vs「苹果当前库存」),必须借共享的商品名判断同一商品 —— 否则合法的
        // 「同商品闭环」会被误判跨商品而拒绝,造成假阴性。
        const products = steps
          .filter(
            (s): s is QaStepLike & { target: string; value: string } =>
              s.action === "fill" &&
              typeof s.target === "string" &&
              typeof s.value === "string" &&
              /名称/.test(norm(s.target)) &&
              norm(s.value).length > 0,
          )
          .map((s) => norm(s.value));
        /** 两个 target 是否指向同一商品(规范化相等、互相包含,或共享提取出的商品名) */
        const sameProduct = (a: string, b: string) =>
          a === b ||
          a.includes(b) ||
          b.includes(a) ||
          products.some((p) => a.includes(p) && b.includes(p));
        // 阈值:创建商品时用 fill 设定低库存阈值(如「低库存阈值」→ 3)。
        // 低库存规则是 stock <= threshold,回弹数值必须**超过阈值**才算脱离低库存 ——
        // 阈值=3 时回弹到 1 仍是 low,不能只看「>0」。
        const thresholds = steps
          .map((s, i) => ({ s, i }))
          .filter(
            (x): x is { s: QaStepLike & { target: string; value: string }; i: number } =>
              x.s.action === "fill" &&
              typeof x.s.target === "string" &&
              typeof x.s.value === "string" &&
              /阈值/.test(norm(x.s.target)),
          )
          .map((x) => ({ i: x.i, threshold: Number(norm(x.s.value)) }))
          .filter((x) => Number.isFinite(x.threshold));
        // 零边界:数量字段被断言到 0(带 target)
        const zeros = steps
          .map((s, i) => ({ s, i }))
          .filter(
            (x): x is { s: QaStepLike & { target: string; value: string }; i: number } =>
              isQuantity(x.s.action) &&
              typeof x.s.target === "string" &&
              typeof x.s.value === "string" &&
              norm(x.s.value) === "0" &&
              hasMeasure(norm(x.s.target)),
          );
        if (zeros.length === 0) continue;
        // 语义状态断言:expectAttribute(出现) / expectNoAttribute 或不同值(消失)
        const attrs = steps
          .map((s, i) => ({ s, i }))
          .filter(
            (x): x is { s: QaStepLike & { target: string; attr: string; value: string }; i: number } =>
              (x.s.action === "expectAttribute" || x.s.action === "expectNoAttribute") &&
              typeof x.s.target === "string" &&
              typeof x.s.attr === "string" &&
              typeof x.s.value === "string",
          );
        for (const ap of attrs.filter((x) => x.s.action === "expectAttribute")) {
          // 漏洞 1 + 顺序:零边界必须属于同一商品,且必须发生在 low 出现之前 —— 绑定实际匹配的 zero,
          // 只靠「存在一个同商品 zero」不够,先断言标记出现、数量后减到 0 同样证明不了触发条件。
          const zeroBefore = zeros.some(
            (z) => sameProduct(norm(z.s.target), norm(ap.s.target)) && z.i < ap.i,
          );
          if (!zeroBefore) continue;
          // 阈值必须由同一用例在 low 出现**之前**设定 —— 创建商品时填的阈值,才是判定回弹的依据
          const thresholdBefore = thresholds.filter((t) => t.i < ap.i);
          if (thresholdBefore.length === 0) continue;
          const threshold = thresholdBefore[thresholdBefore.length - 1].threshold;
          for (const dp of attrs) {
            // 漏洞 2:出现与消失必须断言同一个 attr(不能 data-state 出现、aria-invalid 消失)
            if (dp.s.attr !== ap.s.attr) continue;
            // 同值正向断言不是「消失」;消失 = 同 attr 的 expectNoAttribute(同值)或断言不同值
            const isDisappear =
              (dp.s.action === "expectNoAttribute" && norm(dp.s.value) === norm(ap.s.value)) ||
              (dp.s.action === "expectAttribute" && norm(dp.s.value) !== norm(ap.s.value));
            if (!isDisappear) continue;
            // 同一商品:出现与消失针对同一 target
            if (norm(dp.s.target) !== norm(ap.s.target)) continue;
            // 顺序:出现先于消失
            if (!(ap.i < dp.i)) continue;
            // 漏洞 3:出现与消失之间必须有**本商品**的 click 补货 + 数量回弹(同 target、值 > 阈值),
            // 不能只写两条属性断言;对别的商品补货/回弹(如香蕉)不构成该商品的越过阈值证据。
            const between = steps.slice(ap.i + 1, dp.i);
            const hasClick = between.some(
              (b) =>
                b.action === "click" &&
                typeof b.target === "string" &&
                sameProduct(norm(b.target), norm(ap.s.target)),
            );
            const rebound = between.some((b) => {
              if (
                !isQuantity(b.action) ||
                typeof b.target !== "string" ||
                typeof b.value !== "string"
              )
                return false;
              if (!sameProduct(norm(b.target), norm(ap.s.target))) return false;
              if (!hasMeasure(norm(b.target))) return false;
              const n = Number(norm(b.value));
              return Number.isFinite(n) && n > threshold;
            });
            if (!hasClick || !rebound) continue;
            return true;
          }
        }
      }
      return false;
    },
  },
};

/**
 * 判定该场景的难点语义是否被 QA 文本覆盖。
 * 返回 { covered, missing } —— missing 列出没匹配到的语义(正则原文 / 结构要求文案)。
 */
export function stressCovered(
  scenarioId: string,
  qaHistory: QaHistoryLike,
): { covered: boolean; missing: string[] } {
  const rules = GUARDRAILS[scenarioId] ?? [];
  const text = qaCaseText(qaHistory);
  const missing: string[] = [];
  for (const re of rules) {
    if (!re.test(text)) missing.push(re.source);
  }
  const structural = STRUCTURAL_GATES[scenarioId];
  if (structural) {
    const cases = qaHistory.flatMap((q) => q.cases);
    if (!structural.check(cases)) missing.push(structural.label);
  }
  return { covered: missing.length === 0, missing };
}

/**
 * QA 压力覆盖门 —— 把「QA 全过但难点没被测到」从可观测升级为硬门。
 *
 * 场景判定不得只因为验收用例全绿就放行进 verify/publish;骨架操作全过、
 * 真正难的语义(连续天数 / 聚合结余 / 时间冲突 / 计时终态…)却一个用例都没碰到,
 * 是最高频的假阳。covered=false 时必须停下,reason 列出缺失的难点语义。
 */
export function qaStressGate(
  covered: boolean,
  missing: string[],
): { ok: boolean; reason?: string } {
  if (covered) return { ok: true };
  return { ok: false, reason: `QA 未覆盖难点语义:${missing.join("、")}` };
}

/**
 * QA 测试计划覆盖修订循环 —— 纯函数、可确定性单测。
 *
 * 流程:先让 generate 产出用例 → 判难点覆盖 → 缺覆盖就把缺失语义回喂
 * generate 重写测试计划(经 onRetry 发可审计证据),有限次数内覆盖合格为止。
 *
 * 判定必须只看**当前最终版**的用例,绝不合并历史轮次:真正执行的是最后这版,
 * 若第 1 版覆盖了语义 A、第 2 版覆盖了 B 却丢了 A,合并判覆盖会假通过 ——
 * 覆盖修订的核心就是保证「这一版」测到了全部重点,丢掉的覆盖不能靠旧版洗白。
 * 因此每轮重写后都用 stressCovered(scenarioId, [{ cases: 当前版 }]) 单独判定。
 *
 * scenarioId 为空时只跳过场景专用规则；若传了 requiredFeatures，正常用户链路仍要
 * 覆盖全部 PRD P0 功能。两类缺失合并后一起回喂，避免测试 runner 与真实产品分叉。
 */
export interface CoverageLoopOptions<T extends QaCaseLike = QaCaseLike> {
  scenarioId?: string;
  /** 正常用户链路也必须覆盖的 PRD P0 功能名。 */
  requiredFeatures?: string[];
  /** 覆盖修订的最大轮数(0 = 首轮必须合格,否则立即判缺覆盖) */
  maxRetries: number;
  /** 产出一版测试计划;missing 存在时是一次覆盖修订(要重写补上缺失语义) */
  generate: (missing?: string[]) => Promise<T[]>;
  /**
   * 对整版测试计划的附加体检,返回的每条都会并入 missing 一起回喂重写。
   *
   * 覆盖门问的是「该测的测了没有」,这里问的是「写下来的这些**执行得了吗**」——
   * 两者都是测试计划自身的问题,都该在 runTests 之前解决,所以共用同一个
   * 重试预算和同一条回喂通道,而不是各建一套循环。
   */
  inspect?: (cases: T[]) => string[];
  /** 每个重试轮次的回调 —— 调用方在此留可审计痕迹(如 qa.coverage_retry 事件) */
  onRetry: (round: number, missing: string[]) => void;
}

export interface CoverageLoopResult<T extends QaCaseLike = QaCaseLike> {
  /** 最后一版(覆盖修订后)的测试计划 */
  cases: T[];
  /** 实际用掉的重试轮数(0 = 首轮就覆盖合格) */
  rounds: number;
  covered: boolean;
  missing: string[];
}

export async function ensureCoverage<T extends QaCaseLike>(
  opts: CoverageLoopOptions<T>,
): Promise<CoverageLoopResult<T>> {
  const missingFor = (cases: T[]) => {
    const scenarioMissing = opts.scenarioId
      ? stressCovered(opts.scenarioId, [{ cases }]).missing
      : [];
    const featureMissing = featureCoverageMissing(opts.requiredFeatures ?? [], cases);
    const inspected = opts.inspect?.(cases) ?? [];
    return [...new Set([...scenarioMissing, ...featureMissing, ...inspected])];
  };
  let cases = await opts.generate();
  let missing = missingFor(cases);
  let rounds = 0;
  while (missing.length > 0 && rounds < opts.maxRetries) {
    rounds++;
    opts.onRetry(rounds, missing);
    cases = await opts.generate(missing);
    missing = missingFor(cases);
  }
  return { cases, rounds, covered: missing.length === 0, missing };
}
