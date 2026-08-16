/**
 * 质量门注册表 —— 由**产出了什么**触发,不由流程走到哪触发。
 *
 * 流程一旦交给调度器现场决定,「第 N 步之后跑门」这个位置就不存在了。
 * 所以门改成挂在产物上:出现新代码就必然构建、必然审计,不管此刻走到哪一步。
 * 本质是 hook,但有三个限定词,价值全在这三个词上:
 *
 *   1. 不能被跳过 —— 角色无权关它,调度器也无权关它。这张表是平台侧的
 *      静态配置,不接受运行期修改。否则调度器为了收敛可以关掉一道门,
 *      然后基于假事实做下一次决策 —— 动态调度让这个风险比固定流程时更大。
 *
 *   2. 有返回值,且进状态 —— 门不只是拦一下,它产出**事实**:
 *      构建错误、失败用例、客观缺陷,都会喂回给调度器当作下一轮的决策依据。
 *      所以它是「产物 → 事实」的转换器,不是一个副作用回调。
 *
 *   3. 平台独占,不含 LLM —— 判定要么是确定性的,要么基于确定性采证。
 *      这是「不信自我汇报」唯一能落地的地方:门没法被说服。
 *
 * 关于 blocking:并非所有门都该杀掉一次生成。判「产物有没有问题」的门阻塞;
 * 判「测试计划自身合不合格」的门只警告 —— 因为门自己也可能判错,
 * 而它判错的代价是整场作废且没有任何失败证据,计划真弱的代价只是这轮验证弱一点。
 * 代价不对称时,选可恢复的那边。
 */

import { auditTimerSafety } from "./timer-safety";
import { buildApp, type BuildSuccess } from "./builder";
import { checkTargets } from "./targetGate";
import { collectDeliveryEvidence, type DeliveryEvidence } from "./delivery";
import { runTests, type TestReport } from "./testrunner";
import { stressCovered } from "./stressCoverage";
import type { GeneratedFile } from "./events";
import type { Prd } from "./contracts";
import type { TestCase } from "./testrunner";

/** 门挂在什么上 —— 全部是「产物出现了」或「某个阶段性事实成立了」 */
export type GateTrigger =
  /** 出现了新的源码 */
  | "artifact:files"
  /** 出现了新的测试计划 */
  | "artifact:tests"
  /** 代码已构建通过,可以真实渲染 */
  | "state:code-ready"
  /** 功能验收已通过,准备交付 */
  | "state:qa-passed";

export interface GateContext {
  runId: string;
  files: GeneratedFile[];
  prd?: Prd;
  cases?: TestCase[];
  /** 已构建产物 —— code-ready 之后的门直接复用,不重复构建 */
  built?: BuildSuccess;
  /** 渲染好的宿主页面 */
  html?: string;
  /** 场景 id —— 跑批时用来做难点覆盖检查,真实用户没有 */
  scenarioId?: string;
  /** 界面探查采到的真实控件名,交给 target 门用 */
  screenNames?: string[];
}

export interface GateVerdict {
  ok: boolean;
  /** 人类可读的事实,进事件流、喂给调度器 */
  facts: string[];
  /** 结构化证据,类型按门而异,供下游角色使用 */
  evidence?: unknown;
}

export interface Gate {
  id: string;
  /** 群聊里显示的名字 */
  name: string;
  on: GateTrigger;
  /**
   * true  = 不过就停,产物有问题
   * false = 不过只记录,门自己也可能判错
   */
  blocking: boolean;
  run(ctx: GateContext): Promise<GateVerdict>;
}

/* ----------------------------- 各道门 ----------------------------- */

const buildGate: Gate = {
  id: "build",
  name: "构建门",
  on: "artifact:files",
  blocking: true,
  async run(ctx) {
    const built = await buildApp(ctx.files);
    if (built.ok) {
      return {
        ok: true,
        facts: [`构建通过,产物 ${(built.bytes / 1024).toFixed(0)}KB`],
        evidence: built,
      };
    }
    return {
      ok: false,
      // 原样带上编译器的话 —— 让工程师看见真正的报错,而不是「构建失败了」
      facts: built.errors.map((e) => e.message),
    };
  },
};

const staticAuditGate: Gate = {
  id: "static-audit",
  name: "静态审计",
  on: "artifact:files",
  blocking: true,
  async run(ctx) {
    const report = auditTimerSafety(ctx.files);
    // enabled=false 表示这批源码里没有该规则适用的写法,不是「通过」也不是「失败」
    if (!report.enabled) return { ok: true, facts: [] };
    return report.ok
      ? { ok: true, facts: ["静态审计通过"] }
      : { ok: false, facts: report.reasons };
  },
};

const testPlanGate: Gate = {
  id: "test-plan",
  name: "测试计划体检",
  on: "artifact:tests",
  // 只警告。这道门连着判错过好几次 —— 每次去查现场,结论都是门错了,
  // 不是计划弱。而它判错会让整场生成作废、且没有任何失败证据。
  blocking: false,
  async run(ctx) {
    const cases = ctx.cases ?? [];
    const facts: string[] = [];

    // 该测的测了没有
    if (ctx.scenarioId) {
      const cov = stressCovered(ctx.scenarioId, [{ cases }]);
      if (!cov.covered) facts.push(...cov.missing.map((m) => `缺覆盖:${m}`));
    }

    // 写下来的这些执行得了吗
    const t = checkTargets(cases, ctx.files, { names: ctx.screenNames ?? [] });
    facts.push(...t.problems);

    return { ok: facts.length === 0, facts };
  },
};

const functionalGate: Gate = {
  id: "functional",
  name: "功能验收",
  on: "state:code-ready",
  blocking: true,
  async run(ctx) {
    if (!ctx.html) return { ok: false, facts: ["还没有可运行的页面"] };
    const cases = ctx.cases ?? [];
    if (cases.length === 0) return { ok: false, facts: ["没有可执行的验收用例"] };

    const report: TestReport = await runTests(ctx.html, ctx.runId, cases);
    if (report.failed === 0) {
      return { ok: true, facts: [`${report.passed} 条用例全部通过`], evidence: report };
    }
    return {
      ok: false,
      // 带上「第几步、期望什么、实际什么」—— 调度器要靠这些判断这是哪一层的问题
      facts: report.failures.map((f) => `${f.case}:第 ${f.stepIndex + 1} 步 ${f.message}`),
      evidence: report,
    };
  },
};

const deliveryGate: Gate = {
  id: "delivery",
  name: "交付采证",
  on: "state:qa-passed",
  blocking: true,
  async run(ctx) {
    if (!ctx.html || !ctx.built) return { ok: false, facts: ["还没有可交付的产物"] };
    const ev: DeliveryEvidence = await collectDeliveryEvidence(
      ctx.html,
      ctx.built.css,
      ctx.runId,
    );
    // 客观缺陷不需要讨论,直接是不通过;主观判断留给产品负责人,不在这道门里做
    return {
      ok: ev.hardIssues.length === 0,
      facts: ev.hardIssues,
      evidence: ev,
    };
  },
};

/**
 * 平台侧静态注册表。
 *
 * 刻意导出成 readonly 且不提供任何注册/注销函数 —— 门的集合在编译期就定死,
 * 运行期没有任何代码路径能改它。这是第 1 条限定词的实现方式。
 */
export const GATES: readonly Gate[] = Object.freeze([
  buildGate,
  staticAuditGate,
  testPlanGate,
  functionalGate,
  deliveryGate,
]);

export interface GateRunResult {
  /** 阻塞门全过才为 true —— 调度器据此决定能不能往下走 */
  passed: boolean;
  verdicts: {
    gate: string;
    name: string;
    ok: boolean;
    blocking: boolean;
    facts: string[];
    durationMs: number;
    evidence?: unknown;
  }[];
  /** 所有门产出的事实合起来,喂给调度器 */
  facts: string[];
}

/**
 * 跑某个触发点上的全部门。
 *
 * 阻塞门一旦不过就**立刻停下**,不再跑后面的 —— 代码都编译不过时,
 * 再去审计它的写法只是浪费时间,而且报出来的问题多半是编译失败的余波,
 * 会把真正的原因淹掉。
 */
export async function runGates(
  trigger: GateTrigger,
  ctx: GateContext,
): Promise<GateRunResult> {
  const verdicts: GateRunResult["verdicts"] = [];
  const facts: string[] = [];
  let passed = true;

  for (const gate of GATES.filter((g) => g.on === trigger)) {
    const started = Date.now();
    const v = await gate.run(ctx);
    const durationMs = Date.now() - started;

    verdicts.push({
      gate: gate.id,
      name: gate.name,
      ok: v.ok,
      blocking: gate.blocking,
      facts: v.facts,
      durationMs,
      evidence: v.evidence,
    });
    facts.push(...v.facts);

    if (!v.ok && gate.blocking) {
      passed = false;
      break;
    }
  }

  return { passed, verdicts, facts };
}
