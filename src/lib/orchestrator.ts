/**
 * 主循环 —— 把角色、门、预算串起来。
 *
 * 和上一版最大的不同:**这里没有流程**。
 * 没有 phasePm → phaseDesign → phaseCode 这样的顺序,只有一个循环:
 *
 *     问 Piper 派给谁 → 那个人干活 → 产物触发门 → 事实回流 → 再问 Piper
 *
 * 所以「测试挂了该找谁」「老板中途改需求该谁接」不需要预先写成分支 ——
 * 它们本来就是同一个问题的不同实例,交给 Piper 现场判断。
 *
 * 这带来的代价写在架构文档里:同一个需求两次跑,过程可能不同。
 * 缓解手段是每次派单的 next/reason 都进事件流,回放严格按记录走、不重调模型。
 *
 * 三条纪律,都在下面的代码里能指出具体位置:
 *   预算 check 在派单**之前** —— Piper 无权突破,它只拿到渲染好的余额文字
 *   门由产物触发,不由位置触发 —— 角色产出什么就跑什么,不看流程走到哪
 *   耗尽 ≠ 失败 —— 有能跑的产物就交付并说清遗留问题
 */

import {
  DispatchSchema,
  HandoffSchema,
  dispatchPrompt,
  handoffPrompt,
  type Dispatch,
  type DispatchView,
} from "./piper";
import {
  DesignSchema,
  PrdSchema,
  TestCaseSchema,
  VisualDesignSchema,
  AcceptanceSchema,
  architectPrompt,
  engineerPrompt,
  fixPrompt,
  parseFileBlocks,
  pmPrompt,
  qaPrompt,
  visualDesignerPrompt,
  acceptancePrompt,
  type Design,
  type Prd,
  type VisualDesign,
} from "./roles";
import { callAgentParsed, extractJson } from "./agent-call";
import { runGates, type GateRunResult } from "./gates";
import {
  DEFAULT_LIMITS,
  checkDispatch,
  describe as describeBudget,
  emptyBudget,
  failureSignature,
  spend,
  record,
  type BudgetState,
} from "./budget";
import { appHtml, buildApp, type BuildSuccess } from "./builder";
import { collectScreenInventory, type ScreenInventory } from "./delivery";
import { EventSink } from "./sink";
import { RUNTIME_PATHS, withRuntimeFiles } from "./runtime-files";
import { getStore } from "./store";
import type { GeneratedFile, NodeId } from "./events";
import type { TestCase } from "./testrunner";

/** 一次 run 的全部工作状态。由事件流拥有,这里只是循环内的镜像 */
interface WorkState {
  request: string;
  followUps: string[];
  model: string;
  prd?: Prd;
  visual?: VisualDesign;
  design?: Design;
  files: GeneratedFile[];
  cases?: TestCase[];
  built?: BuildSuccess;
  html?: string;
  screenNames: string[];
  screen?: ScreenInventory;
  /** 最近一次门产出的事实 —— 下一轮决策的主要依据 */
  facts: string[];
  gatesPassed: boolean;
  last?: { role: NodeId; brief: string };
  /** 派过谁、让他干什么 —— 卡住时交代给老板 */
  attempts: string[];
  budget: BudgetState;
  scenarioId?: string;
  /** 只有交付门与 Ida 验收都通过后才为 true。任何上游产物变化都会重置 */
  accepted: boolean;
  /** 最近一次功能验收是否针对当前代码通过。 */
  qaPassed: boolean;
}

export interface RunResult {
  status: "succeeded" | "handoff" | "failed" | "awaiting_approval";
  files: GeneratedFile[];
}

const authored = (files: GeneratedFile[]) =>
  files.filter((f) => !RUNTIME_PATHS.has(f.path));

/** 修复角色只返回改动文件；按路径覆盖，不能把未改文件从项目里删掉。 */
export function mergeGeneratedFiles(
  current: GeneratedFile[],
  changed: GeneratedFile[],
): GeneratedFile[] {
  const files = new Map(authored(current).map((f) => [f.path, f]));
  for (const file of changed) files.set(file.path, file);
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 产物出现之后,把该跑的门都跑掉,并把事实写回状态。
 *
 * 这里体现「门由产物触发」:调用方只说「我产出了 files」,
 * 跑哪几道门是注册表决定的,编排层不挑。
 */
async function fireGates(
  sink: EventSink,
  st: WorkState,
  trigger: Parameters<typeof runGates>[0],
  runId: string,
): Promise<GateRunResult> {
  if (trigger === "artifact:files") {
    sink.emit({ type: "build.started", attempt: st.budget.dispatches });
  } else if (trigger === "state:code-ready") {
    sink.emit({ type: "qa.started", attempt: st.budget.dispatches });
  }

  const r = await runGates(trigger, {
    runId,
    files: st.files,
    prd: st.prd,
    cases: st.cases,
    built: st.built,
    html: st.html,
    scenarioId: st.scenarioId,
    screenNames: st.screenNames,
  });

  for (const v of r.verdicts) {
    sink.emit({
      type: "gate.verdict",
      gate: v.gate,
      trigger,
      ok: v.ok,
      blocking: v.blocking,
      facts: v.facts,
      durationMs: v.durationMs,
    });

    if (v.gate === "build") {
      const built = v.evidence as BuildSuccess | undefined;
      sink.emit({
        type: "build.result",
        attempt: st.budget.dispatches,
        ok: v.ok,
        bytes: built?.ok ? built.bytes : undefined,
        durationMs: v.durationMs,
        errors: v.ok ? [] : v.facts,
      });
    }

    if (v.gate === "functional") {
      const report = v.evidence as
        | { passed: number; failed: number; durationMs: number; failures: { case: string; stepIndex: number; message: string }[] }
        | undefined;
      const cases = (st.cases ?? []).map((tc) => {
        const failure = report?.failures.find((f) => f.case === tc.name);
        return {
          name: tc.name,
          covers: tc.covers,
          ok: Boolean(report) && !failure,
          reason: failure ? `第 ${failure.stepIndex + 1} 步 ${failure.message}` : undefined,
        };
      });
      sink.emit({
        type: "qa.result",
        attempt: st.budget.dispatches,
        passed: report?.passed ?? 0,
        failed: report?.failed ?? cases.length,
        durationMs: report?.durationMs ?? v.durationMs,
        cases,
      });
      st.qaPassed = v.ok;
    }
  }

  st.facts = r.facts;
  st.gatesPassed = r.passed;

  // 构建门的产物顺手留下 —— 后面的门和交付都要用,不重复构建
  const build = r.verdicts.find((v) => v.gate === "build");
  if (build?.ok && build.evidence) {
    st.built = build.evidence as BuildSuccess;
    st.html = appHtml({
      title: st.prd?.title ?? "应用",
      js: st.built.js,
      css: st.built.css,
      runId,
      apiBase: "",
      embed: true,
    });
  }
  return r;
}

/** 把当前局面整理成 Piper 看的视图 —— 全部是已发生的事实,不含预测 */
function viewOf(st: WorkState, warn?: string): DispatchView {
  return {
    request: st.request,
    followUps: st.followUps,
    prd: st.prd,
    visual: st.visual,
    design: st.design,
    hasCode: st.files.length > 0,
    hasTests: (st.cases?.length ?? 0) > 0,
    last: st.last,
    facts: st.facts,
    gatesPassed: st.gatesPassed,
    qaPassed: st.qaPassed,
    accepted: st.accepted,
    budget: describeBudget(st.budget),
    warn,
  };
}

/** 把 EventSink 的真实累计用量同步进调度预算，避免重复累加。 */
function syncUsage(st: WorkState, sink: EventSink) {
  const tokenDelta = Math.max(0, sink.totals.totalTokens - st.budget.tokens);
  const costDelta = Math.max(0, sink.totals.costUsd - st.budget.costUsd);
  if (tokenDelta > 0 || costDelta > 0) {
    st.budget = record(st.budget, { totalTokens: tokenDelta, costUsd: costDelta });
  }
}

function budgetWarning(st: WorkState): string | undefined {
  const remaining = DEFAULT_LIMITS.maxDispatches - st.budget.dispatches;
  return st.budget.dispatches / DEFAULT_LIMITS.maxDispatches >= 0.7
    ? `预算只剩 ${remaining} 轮，优先完成最确定的动作；没有把握时交给人，不要继续试探。`
    : undefined;
}

/** 平台拥有最终完成判定权，Piper 只能提出 done，不能绕过这些事实。 */
export function completionIssues(st: {
  prd?: unknown;
  visual?: unknown;
  design?: unknown;
  files: GeneratedFile[];
  cases?: TestCase[];
  built?: BuildSuccess;
  html?: string;
  accepted?: boolean;
  qaPassed?: boolean;
}): string[] {
  const missing: string[] = [];
  if (!st.prd) missing.push("PRD");
  if (!st.visual) missing.push("视觉方案");
  if (!st.design) missing.push("架构设计");
  if (authored(st.files).length === 0) missing.push("代码");
  if (!st.built || !st.html) missing.push("最新代码构建");
  if ((st.cases?.length ?? 0) === 0) missing.push("验收用例");
  if (!st.qaPassed) missing.push("功能验收通过");
  if (!st.accepted) missing.push("交付验收");
  return missing;
}

function completionReady(st: WorkState): boolean {
  return completionIssues(st).length === 0;
}

/* --------------------------- 五个角色干活 --------------------------- */

async function runRole(
  sink: EventSink,
  st: WorkState,
  next: Dispatch["next"],
  brief: string,
  runId: string,
  signal?: AbortSignal,
): Promise<void> {
  const model = st.model;

  if (next === "pm") {
    st.accepted = false;
    st.qaPassed = false;
    st.built = undefined;
    st.html = undefined;
    const p = pmPrompt(`${st.request}\n\n本轮要求:${brief}`);
    st.prd = await callAgentParsed(
      sink,
      { node: "pm", model, system: p.system, user: p.user, maxTokens: 8000, jsonMode: true },
      (raw) => PrdSchema.parse(extractJson(raw)),
      signal,
    );
    sink.emit({ type: "artifact", kind: "prd", data: st.prd });
    await getStore().updateRun(runId, { label: st.prd.title }).catch(() => {});
    return;
  }

  if (next === "designer") {
    if (!st.prd) throw new Error("还没有 PRD,设计无从下手");
    st.accepted = false;
    st.qaPassed = false;
    st.built = undefined;
    st.html = undefined;
    const p = visualDesignerPrompt(`${st.request}\n\n本轮要求:${brief}`, st.prd);
    st.visual = await callAgentParsed(
      sink,
      { node: "designer", model, system: p.system, user: p.user, maxTokens: 8000, jsonMode: true },
      (raw) => VisualDesignSchema.parse(extractJson(raw)),
      signal,
    );
    sink.emit({ type: "artifact", kind: "visual", data: st.visual });
    return;
  }

  if (next === "architect") {
    if (!st.prd || !st.visual) throw new Error("架构要在 PRD 与视觉方案之后");
    st.accepted = false;
    st.qaPassed = false;
    st.built = undefined;
    st.html = undefined;
    const p = architectPrompt(`${st.request}\n\n本轮要求:${brief}`, st.prd, st.visual);
    st.design = await callAgentParsed(
      sink,
      { node: "architect", model, system: p.system, user: p.user, maxTokens: 8000, jsonMode: true },
      (raw) => DesignSchema.parse(extractJson(raw)),
      signal,
    );
    sink.emit({ type: "artifact", kind: "design", data: st.design });
    return;
  }

  if (next === "engineer") {
    if (!st.prd || !st.design || !st.visual) throw new Error("实现要在设计之后");
    st.accepted = false;
    st.qaPassed = false;
    // 新源码出现后，旧构建产物不再代表当前文件，失败时也绝不能回退使用旧 bundle。
    st.built = undefined;
    st.html = undefined;
    st.screenNames = [];
    st.screen = undefined;

    // 已经有代码 = 这是一次修复,把门产出的事实原样交给他
    const isFix = st.files.length > 0;
    const p = isFix
      ? fixPrompt(
          authored(st.files),
          // 门产出的事实原样交给他 —— 让他看见真正的报错,而不是「有问题」
          st.facts.map((m) => ({ kind: "static" as const, message: m })),
          st.budget.sameRoleStreak,
        )
      : engineerPrompt(`${st.request}\n\n本轮要求:${brief}`, st.prd, st.design, st.visual);
    const code = await callAgentParsed(
      sink,
      {
        node: isFix ? "fix" : "engineer",
        model,
        system: p.system,
        user: `${p.user}\n\n本轮要求:${brief}`,
        maxTokens: 24000,
        thinking: "disabled",
      },
      parseFileBlocks,
      signal,
    );
    st.files = withRuntimeFiles(isFix ? mergeGeneratedFiles(st.files, code.files) : code.files);
    sink.emit({ type: "artifact", kind: "files", data: authored(st.files) });

    await fireGates(sink, st, "artifact:files", runId);
    // 代码可跑之后顺手探一次界面 —— 这不是门,是给 Tess 的信息
    if (st.gatesPassed && st.html) {
      try {
        const inv = await collectScreenInventory(st.html, runId);
        st.screen = inv;
        st.screenNames = [...new Set([
          ...inv.clickables,
          ...inv.inputs,
          ...inv.regions,
          ...inv.headings,
          ...(inv.afterOpen?.inputs ?? []),
          ...(inv.afterOpen?.clickables ?? []),
          ...(inv.afterCreate?.clickables ?? []),
        ])];
        sink.emit({
          type: "screen.probed",
          ok: true,
          layers: 1 + (inv.afterOpen ? 1 : 0) + (inv.afterCreate ? 1 : 0),
          clickables: [...new Set([
            ...inv.clickables,
            ...(inv.afterOpen?.clickables ?? []),
            ...(inv.afterCreate?.clickables ?? []),
          ])],
          inputs: [...new Set([
            ...inv.inputs,
            ...(inv.afterOpen?.inputs ?? []),
            ...(inv.afterCreate?.inputs ?? []),
          ])],
          regions: inv.regions,
          openedVia: inv.afterOpen?.via,
          createdVia: inv.afterCreate?.via,
        });
      } catch {
        st.screenNames = [];
        st.screen = undefined;
        sink.emit({
          type: "screen.probed",
          ok: false,
          layers: 0,
          clickables: [],
          inputs: [],
          regions: [],
        });
      }
    }
    return;
  }

  if (next === "qa") {
    if (!st.prd) throw new Error("没有 PRD,不知道该验什么");
    st.accepted = false;
    st.qaPassed = false;
    const visible = st.screen;
    const p = qaPrompt(st.prd, authored(st.files), brief, undefined, {
      clickables: [
        ...(visible?.clickables ?? []),
        ...(visible?.afterOpen?.clickables ?? []),
        ...(visible?.afterCreate?.clickables ?? []),
      ],
      inputs: [
        ...(visible?.inputs ?? []),
        ...(visible?.afterOpen?.inputs ?? []),
        ...(visible?.afterCreate?.inputs ?? []),
      ],
      regions: visible?.regions ?? [],
      headings: visible?.headings ?? [],
    });
    const plan = await callAgentParsed(
      sink,
      { node: "qa", model, system: p.system, user: p.user, maxTokens: 20000, jsonMode: true },
      (raw) => TestCaseSchema.parse(extractJson(raw)),
      signal,
    );
    st.cases = plan.cases as TestCase[];
    sink.emit({ type: "artifact", kind: "tests", data: st.cases });

    await fireGates(sink, st, "artifact:tests", runId);
    // 计划体检是非阻塞的,不管过没过都直接执行
    await fireGates(sink, st, "state:code-ready", runId);
    return;
  }

  if (next === "accept") {
    st.accepted = false;
    sink.emit({ type: "accept.started", attempt: st.budget.dispatches });
    if (!st.qaPassed) {
      const hardIssues = ["功能验收尚未针对当前代码通过"];
      sink.emit({
        type: "accept.result",
        attempt: st.budget.dispatches,
        accepted: false,
        dimensions: {
          functional: { ok: false, note: hardIssues[0] },
          usability: { ok: false, note: "未进入主观验收" },
          visual: { ok: false, note: "未进入主观验收" },
        },
        issues: [],
        hardIssues,
        summary: "请先完成 Tess 功能验收",
      });
      st.facts = hardIssues;
      st.gatesPassed = false;
      return;
    }
    const qaFacts = [...st.facts];
    const gate = await fireGates(sink, st, "state:qa-passed", runId);
    const evidence = gate.verdicts.find((v) => v.gate === "delivery")?.evidence;
    if (!gate.passed || !st.prd || !evidence) {
      const hardIssues = gate.facts.length > 0 ? gate.facts : ["交付证据不完整"];
      sink.emit({
        type: "accept.result",
        attempt: st.budget.dispatches,
        accepted: false,
        dimensions: {
          functional: { ok: false, note: "尚未满足交付前置条件" },
          usability: { ok: false, note: "未进入主观验收" },
          visual: { ok: false, note: "未进入主观验收" },
        },
        issues: [],
        hardIssues,
        summary: "平台交付门未通过",
      });
      st.facts = hardIssues;
      st.gatesPassed = false;
      return;
    }

    const p = acceptancePrompt({
      prd: st.prd,
      visual: st.visual,
      evidence: evidence as Parameters<typeof acceptancePrompt>[0]["evidence"],
      qaSummary: qaFacts.join("\n"),
    });
    const verdict = await callAgentParsed(
      sink,
      { node: "accept", model, system: p.system, user: p.user, maxTokens: 4000, jsonMode: true },
      (raw) => AcceptanceSchema.parse(extractJson(raw)),
      signal,
    );
    // 客观缺陷一票否决 —— 模型说通过也不算数
    const hard = (evidence as { hardIssues?: string[] }).hardIssues ?? [];
    const dimensions = {
      functional: verdict.functional,
      usability: verdict.usability,
      visual: verdict.visual,
    };
    const accepted =
      verdict.accepted &&
      dimensions.functional.ok &&
      dimensions.usability.ok &&
      dimensions.visual.ok &&
      hard.length === 0;
    sink.emit({
      type: "accept.result",
      attempt: st.budget.dispatches,
      accepted,
      dimensions,
      issues: verdict.issues,
      hardIssues: hard,
      summary: verdict.summary,
    });
    st.accepted = accepted;
    st.facts = accepted
      ? ["交付验收通过"]
      : [
          ...hard,
          ...verdict.issues.map((i) => `${i.dimension}:${i.problem}；期望:${i.expectation}`),
          ...(verdict.issues.length === 0 && hard.length === 0 ? [verdict.summary || "验收未通过"] : []),
        ];
    st.gatesPassed = accepted;
    return;
  }
}

/* ------------------------------ 主循环 ------------------------------ */

export async function runLoop(
  sink: EventSink,
  input: {
    runId: string;
    request: string;
    model: string;
    followUps?: string[];
    scenarioId?: string;
    initial?: Partial<WorkState>;
    /** 打开需求审核时，Ida 产出 PRD 后暂停，等待用户批准或改写。 */
    pauseAfterPrd?: boolean;
    /** 同一项目续跑时不重复制造 run.started。 */
    emitRunStarted?: boolean;
  },
  signal?: AbortSignal,
): Promise<RunResult> {
  const st: WorkState = {
    request: input.request,
    followUps: input.followUps ?? [],
    model: input.model,
    files: [],
    screenNames: [],
    facts: [],
    gatesPassed: true,
    attempts: [],
    budget: emptyBudget(),
    accepted: false,
    qaPassed: false,
    scenarioId: input.scenarioId,
    ...input.initial,
  };

  if (input.emitRunStarted !== false) {
    sink.emit({
      type: "run.started",
      prompt: input.request,
      model: input.model,
    });
  }

  for (;;) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("运行已取消");
    }

    // ---- 问 Piper:下一步派给谁 ----
    const dp = dispatchPrompt(viewOf(st, budgetWarning(st)));
    const decision = await callAgentParsed<Dispatch>(
      sink,
      {
        node: "dispatch",
        model: st.model,
        system: dp.system,
        user: dp.user,
        maxTokens: 2000,
        jsonMode: true,
      },
      (raw) => DispatchSchema.parse(extractJson(raw)),
      signal,
    );
    syncUsage(st, sink);

    if (decision.next === "done") {
      sink.emit({
        type: "dispatch.decided",
        round: st.budget.dispatches + 1,
        next: "done",
        reason: decision.reason,
        brief: decision.brief,
        budget: {
          dispatches: st.budget.dispatches,
          maxDispatches: DEFAULT_LIMITS.maxDispatches,
        },
      });
      const missing = completionIssues(st);
      if (missing.length === 0) {
        await finish(sink, input.runId, "succeeded");
        return { status: "succeeded", files: st.files };
      }

      const rejection = `平台拒绝结束：还缺 ${missing.join("、")}。请选择对应角色继续完成。`;
      const sig = failureSignature([rejection]);
      const check = checkDispatch(st.budget, "done", sig);
      if (!check.allowed) {
        await handoff(sink, st, check.reason, input.runId, signal);
        return { status: "handoff", files: st.files };
      }
      st.budget = spend(st.budget, "done", sig);
      st.facts = [rejection];
      st.gatesPassed = false;
      st.last = { role: "dispatch", brief: decision.brief };
      st.attempts.push(`Piper 请求结束但被平台拒绝：${missing.join("、")}`);
      sink.emit({
        type: "budget.spent",
        dispatches: st.budget.dispatches,
        maxDispatches: DEFAULT_LIMITS.maxDispatches,
        sameRoleStreak: st.budget.sameRoleStreak,
        tokens: st.budget.tokens,
        costUsd: st.budget.costUsd,
      });
      continue;
    }

    if (decision.next === "ask_human") {
      sink.emit({
        type: "dispatch.decided",
        round: st.budget.dispatches + 1,
        next: "ask_human",
        reason: decision.reason,
        brief: decision.brief,
        budget: {
          dispatches: st.budget.dispatches,
          maxDispatches: DEFAULT_LIMITS.maxDispatches,
        },
      });
      await handoff(sink, st, decision.reason, input.runId, signal);
      return { status: "handoff", files: st.files };
    }

    // ---- 预算在派单**之前**判 —— Piper 无权突破 ----
    const sig = st.gatesPassed ? undefined : failureSignature(st.facts);
    const check = checkDispatch(st.budget, decision.next as NodeId, sig);
    if (!check.allowed) {
      await handoff(sink, st, check.reason, input.runId, signal);
      return { status: "handoff", files: st.files };
    }

    st.budget = spend(st.budget, decision.next as NodeId, sig);
    sink.emit({
      type: "dispatch.decided",
      round: st.budget.dispatches,
      next: decision.next as NodeId,
      reason: decision.reason,
      brief: decision.brief,
      budget: {
        dispatches: st.budget.dispatches,
        maxDispatches: DEFAULT_LIMITS.maxDispatches,
      },
    });
    st.last = { role: decision.next as NodeId, brief: decision.brief };
    st.attempts.push(`派给 ${decision.next}:${decision.brief} —— ${decision.reason}`);

    // ---- 那个人干活。他的产物会自动触发对应的门 ----
    try {
      await runRole(sink, st, decision.next, decision.brief, input.runId, signal);
    } catch (err) {
      // 角色本身炸了(schema 连续解析失败等)也是一条事实,交给 Piper 判断
      st.facts = [err instanceof Error ? err.message : String(err)];
      st.gatesPassed = false;
    } finally {
      syncUsage(st, sink);
      sink.emit({
        type: "budget.spent",
        dispatches: st.budget.dispatches,
        maxDispatches: DEFAULT_LIMITS.maxDispatches,
        sameRoleStreak: st.budget.sameRoleStreak,
        tokens: st.budget.tokens,
        costUsd: st.budget.costUsd,
      });
    }

    if (input.pauseAfterPrd && decision.next === "pm" && st.prd) {
      sink.emit({ type: "hitl.awaiting", node: "pm", kind: "prd" });
      await getStore()
        .updateRun(input.runId, { status: "awaiting_approval", totals: sink.totals })
        .catch(() => {});
      await sink.flush();
      return { status: "awaiting_approval", files: st.files };
    }
  }
}

/**
 * 卡住时交代给老板 —— 不是「失败了」。
 *
 * 已经有能跑的产物时,run 仍然算 succeeded:老板宁可拿到一个有已知问题的东西。
 * 这条是架构文档里预算规则③的落点。
 */
async function handoff(
  sink: EventSink,
  st: WorkState,
  reason: string,
  runId: string,
  signal?: AbortSignal,
) {
  let summary = reason;
  try {
    const hp = handoffPrompt({ ...viewOf(st), attempts: st.attempts });
    const r = await callAgentParsed(
      sink,
      { node: "dispatch", model: st.model, system: hp.system, user: hp.user, maxTokens: 2000, jsonMode: true },
      (raw) => HandoffSchema.parse(extractJson(raw)),
      signal,
    );
    summary = r.summary;
  } catch {
    /* 交代不出来就用原始理由,不能因为这一步失败把整场的产物丢掉 */
  }

  sink.emit({
    type: "escalated",
    to: "human",
    attempt: st.budget.dispatches,
    reason: summary,
    cases: [],
  });

  const deliverable = completionReady(st);
  await finish(sink, runId, deliverable ? "succeeded" : "failed");
}

async function finish(sink: EventSink, runId: string, status: "succeeded" | "failed") {
  sink.emit({ type: "run.finished", status, totals: sink.totals });
  await getStore().updateRun(runId, { status, totals: sink.totals }).catch(() => {});
  await sink.flush();
}

export { buildApp };
