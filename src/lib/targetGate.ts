/**
 * target 可解析性预检 —— runTests **之前**拦下定位不到的测试步骤。
 *
 * 为什么需要这道门:跑批里最高频的失败不是产品缺陷,而是 Tess 编了一个
 * 界面上并不存在的控件名(「卡片分组」「本周训练量」「露营 票数」),
 * 然后 Ida 把责任归给 Cody,Cody 只能去**猜她想要什么名字** —— 可能的名字是无限的,
 * 于是连修三轮全部落空,最后误判成「疑似测试基础设施异常」。
 *
 * 正确的做法是反转依赖:不让实现去猜测试,而是在执行前就检查测试计划里的
 * 每个 target 是否**可能**解析得到,不可能的直接回喂 Tess 重写。
 * 这与已有的「覆盖门」完全同构 —— 都是在 runTests 前拦测试计划自身的问题,
 * 不冤枉产品侧。
 *
 * 判定规则(确定性、可单测):
 *   把 target 按空白切成词,每个词必须满足其一
 *     · 在源码文本里字面出现 —— 控件文案、aria-label 片段、placeholder
 *     · 是本用例自己 fill 过的值 —— 运行期才产生的数据(商品名、任务名)
 *   两者都不是 = 凭空编造,拦下。
 *
 * 刻意保守:只拦「肯定定位不到」的,不拦「可能定位不到」的。
 * 误拦会让 Tess 反复重写正确的测试计划,那比漏拦更糟。
 */

import type { TestCase, TestStep } from "./testrunner";

export interface TargetGateResult {
  ok: boolean;
  /** 回喂给 Tess 的证据:哪个用例的哪一步、编造了什么 */
  problems: string[];
}

/** 步骤里承载定位语义的字段 */
function targetOf(step: TestStep): string | undefined {
  return "target" in step ? step.target : undefined;
}

/**
 * 归一化:去掉空白与标点后比对。
 * 源码里可能写成 `aria-label={\`${p.name} 出库\`}`,与用例里的「苹果 出库」
 * 无法整串匹配,所以按词比对而不是整串。
 *
 * 标点一律抹掉是**为了少误拦**:用例写「金额(元)」而源码是「金额(元)」
 * (全角半角括号之差)这种事一定会发生,而它显然不是编造。
 * 这道门只该抓「这个词根本不存在」,不该抓「标点没对齐」。
 */
function norm(s: string): string {
  return s
    .replace(/[\s　]+/g, "")
    .replace(/[「」『』"'`()()【】\[\]{}<>《》:,、,.。·・\-—_/|]/g, "");
}

export function checkTargets(
  cases: TestCase[],
  files: { path: string; content: string }[],
  /**
   * 真实渲染出来的控件名(各层合并)。有它时判定必须以它为准。
   *
   * 这道门差点把整个跑批毁掉:执行器后来学会了宽松解析(「待办列」能落到
   * 「待办」区域上、「张三 编辑」能落到那行的编辑按钮上),门却还在拿源码文本
   * 做严格的逐词判断,于是**拒掉了执行器本来跑得通的用例** —— 一次 20 场景
   * 跑批里 16 个失败有 5 个是这么来的,其中包括 kanban、ledger 这些一直很稳的场景。
   *
   * 教训是条硬规则:**门不能比执行器更严**。执行器认得的写法,门必须放行,
   * 否则它拦下的不是错误,是能跑通的东西。
   */
  screen?: { names: string[] },
): TargetGateResult {
  const source = norm(files.map((f) => f.content).join("\n"));
  const realNames = (screen?.names ?? []).map(norm).filter(Boolean);
  /** 与执行器的宽松区域匹配同一套判据:互为子串即认为指的是同一个东西 */
  const relatedToReal = (w: string) =>
    realNames.some((n) => n.includes(w) || w.includes(n));
  /**
   * 与执行器的区域宽松匹配保持一致：模型常给标题补一个描述性后缀，
   * 「想读书架」「待审批列表」「待办列」都可能指向标题为「想读/待审批/待办」
   * 的唯一容器。探查尚未造出数据时看不到这些动态区域，但源码里会有标题词根。
   */
  const withoutRegionSuffix = (value: string) =>
    value.replace(/(?:任务)?(?:书架|列表|区域|标签|分组|栏目|清单|列)$/u, "");
  const problems: string[] = [];

  for (const tc of cases) {
    // 本用例自己填过的值属于运行期数据,源码里当然没有
    const entered = new Set<string>();
    for (const s of tc.steps) {
      if (s.action === "fill" && s.value) entered.add(norm(s.value));
    }

    tc.steps.forEach((step, i) => {
      const target = targetOf(step);
      if (!target) return;

      // 整串就能落到某个真实控件上时直接放行 —— 「待办列」对「待办」区域、
      // 「张三 编辑」对那一行的编辑按钮,执行器都认,门就不该有意见。
      const normalizedTarget = norm(target);
      if (relatedToReal(normalizedTarget)) return;
      const regionStem = withoutRegionSuffix(normalizedTarget);
      if (
        regionStem &&
        regionStem !== normalizedTarget &&
        (source.includes(regionStem) || relatedToReal(regionStem))
      ) return;

      const words = target.split(/[\s　]+/).filter(Boolean);
      const invented = words.filter((w) => {
        const nw = norm(w);
        if (nw.length === 0) return false;
        // 运行期算出来的值:BMI 数值、日期、金额、合计。
        // 它们既不在源码里,也不在探查时的界面上(那会儿还没有记录),
        // 更不是填进去的 —— 但运行时确实会出现。这道门看不见未来,
        // 对这类 token 没有判断力,就不该对它们表态。
        if (/^[\d.,:/\-+%¥$€]+$/.test(nw)) return false;
        if (source.includes(nw)) return false;
        if (relatedToReal(nw)) return false;
        // 用例填入的值,或值的一部分(实现常只显示名称的一段)
        for (const v of entered) {
          if (v.includes(nw) || nw.includes(v)) return false;
        }
        return true;
      });

      if (invented.length > 0) {
        problems.push(
          `用例「${tc.name}」第 ${i + 1} 步的 target「${target}」里,` +
            `「${invented.join("、")}」既不在源码里,也不在应用真实渲染出来的控件里,` +
            `更不是本用例填入的数据 —— 执行时定位不到。` +
            `请改用界面上真实存在的可见文字或 aria-label。`,
        );
      }
    });
  }

  return { ok: problems.length === 0, problems };
}
