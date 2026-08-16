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
  type BudgetState,
} from "./budget";
import { appHtml, buildApp, type BuildSuccess } from "./builder";
import { collectScreenInventory } from "./delivery";
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
  /** 最近一次门产出的事实 —— 下一轮决策的主要依据 */
  facts: string[];
  gatesPassed: boolean;
  last?: { role: NodeId; brief: string };
  /** 派过谁、让他干什么 —— 卡住时交代给老板 */
  attempts: string[];
  budget: BudgetState;
  scenarioId?: string;
}

export interface RunResult {
  status: "succeeded" | "handoff" | "failed";
  files: GeneratedFile[];
}

const authored = (files: GeneratedFile[]) =>
  files.filter((f) => !RUNTIME_PATHS.has(f.path));

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
    budget: describeBudget(st.budget),
    warn,
  };
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
      },
      parseFileBlocks,
      signal,
    );
    st.files = withRuntimeFiles(code.files);
    sink.emit({ type: "artifact", kind: "files", data: authored(st.files) });

    await fireGates(sink, st, "artifact:files", runId);
    // 代码可跑之后顺手探一次界面 —— 这不是门,是给 Tess 的信息
    if (st.gatesPassed && st.html) {
      try {
        const inv = await collectScreenInventory(st.html, runId);
        st.screenNames = [
          ...inv.clickables,
          ...inv.inputs,
          ...inv.regions,
          ...inv.headings,
          ...(inv.afterOpen?.inputs ?? []),
          ...(inv.afterOpen?.clickables ?? []),
          ...(inv.afterCreate?.clickables ?? []),
        ];
      } catch {
        st.screenNames = [];
      }
    }
    return;
  }

  if (next === "qa") {
    if (!st.prd) throw new Error("没有 PRD,不知道该验什么");
    const p = qaPrompt(st.prd, authored(st.files), brief, undefined, {
      clickables: st.screenNames,
      inputs: [],
      regions: [],
      headings: [],
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
    const gate = await fireGates(sink, st, "state:qa-passed", runId);
    const evidence = gate.verdicts.find((v) => v.gate === "delivery")?.evidence;
    if (!st.prd || !evidence) return;

    const p = acceptancePrompt({
      prd: st.prd,
      visual: st.visual,
      evidence: evidence as Parameters<typeof acceptancePrompt>[0]["evidence"],
      qaSummary: st.facts.join("\n"),
    });
    const verdict = await callAgentParsed(
      sink,
      { node: "accept", model, system: p.system, user: p.user, maxTokens: 4000, jsonMode: true },
      (raw) => extractJson(raw) as Record<string, unknown>,
      signal,
    );
    // 客观缺陷一票否决 —— 模型说通过也不算数
    const hard = (evidence as { hardIssues?: string[] }).hardIssues ?? [];
    const accepted = Boolean(verdict.accepted) && hard.length === 0;
    st.facts = accepted ? ["交付验收通过"] : hard.length > 0 ? hard : ["验收未通过"];
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
    scenarioId: input.scenarioId,
    ...input.initial,
  };

  sink.emit({
    type: "run.started",
    prompt: input.request,
    model: input.model,
  });

  for (;;) {
    if (signal?.aborted) return { status: "failed", files: st.files };

    // ---- 问 Piper:下一步派给谁 ----
    const dp = dispatchPrompt(viewOf(st));
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
      await finish(sink, input.runId, "succeeded");
      return { status: "succeeded", files: st.files };
    }

    if (decision.next === "ask_human") {
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
    sink.emit({
      type: "budget.spent",
      dispatches: st.budget.dispatches,
      maxDispatches: DEFAULT_LIMITS.maxDispatches,
      sameRoleStreak: st.budget.sameRoleStreak,
      tokens: sink.totals.totalTokens,
      costUsd: sink.totals.costUsd,
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

  const deliverable = st.files.length > 0 && !!st.built;
  await finish(sink, runId, deliverable ? "succeeded" : "failed");
}

async function finish(sink: EventSink, runId: string, status: "succeeded" | "failed") {
  sink.emit({ type: "run.finished", status, totals: sink.totals });
  await getStore().updateRun(runId, { status, totals: sink.totals }).catch(() => {});
  await sink.flush();
}

export { buildApp };
