/**
 * 事件折叠 —— 把事件流还原成运行时状态。
 *
 * 这是整个系统里最重要的一个函数,因为它有三个消费者且只有一份实现:
 *   1. 实时 UI:边收 SSE 边 fold,画出当前进度
 *   2. 回放 UI:fold 事件流的前 N 条,画出"当时"的样子
 *   3. 服务端:恢复某个 run 的上下文,继续跑下一阶段(无需进程内存)
 *
 * 只要三者共用同一个 fold,"实时看到的"和"回放看到的"就不可能漂移 —— 这不是靠自律保证的,
 * 是靠结构保证的。
 */

import {
  EMPTY_USAGE,
  addUsage,
  type ArtifactKind,
  type ChangeAssessment,
  type Envelope,
  type GeneratedFile,
  type NodeId,
  type QaStepSnapshot,
  type QaTriage,
  type RunEvent,
  type Usage,
  type VerifyIssue,
} from "./events";
import type { Design, Prd, VisualDesign } from "./contracts";
import type { TestCase } from "./testrunner";

export type NodePhase = "idle" | "running" | "done" | "failed";

export interface NodeState {
  /** 事件流里的序号 —— 排序用它,不用时间戳:同一毫秒内的多条事件时间戳会并列 */
  seq: number;
  id: NodeId;
  phase: NodePhase;
  model: string;
  role: string;
  /** 推理模型的思考链,增量拼接 */
  reasoning: string;
  /** 模型正文输出,增量拼接 */
  content: string;
  usage: Usage;
  durationMs: number;
  startedAt: number;
  /** 真实发送的 prompt,供审计展开 */
  prompt: string;
  raw: string;
  error?: string;
  /** 请求层重试了几次(网络抖动等) */
  retries?: number;
  /** 结构化产物被解析打回并修正了几次(第 N 次),只标在被拒绝的那次尝试上 */
  parseRetries?: number;
  /** 推理模式降级痕迹 —— 空转/空响应后下一次重试关闭 thinking 的审计记录 */
  thinkingDegrades?: {
    attempt: number;
    reason: "spiral" | "empty" | "repetition";
    from: "enabled" | "disabled" | "default";
    to: "disabled";
    wastedTokens?: number;
    wastedCostUsd?: number;
  }[];
  /** 同一节点可能被执行多次(修复循环),用于时间轴上区分 */
  runIndex: number;
}

export interface VerifyRecord {
  attempt: number;
  ok: boolean;
  issues: VerifyIssue[];
}

export interface QaRecord {
  seq: number;
  at: number;
  attempt: number;
  passed: number;
  failed: number;
  durationMs: number;
  cases: {
    name: string;
    covers?: string[];
    ok: boolean;
    reason?: string;
    steps?: QaStepSnapshot[];
  }[];
}

/** Ida 对一轮 QA 失败报告的归因与分配记录。 */
export interface QaTriageRecord {
  seq: number;
  at: number;
  attempt: number;
  triage: QaTriage;
}

export interface BuildRecord {
  seq: number;
  at: number;
  attempt: number;
  ok: boolean;
  bytes?: number;
  durationMs: number;
  errors: string[];
}

export interface Escalation {
  seq: number;
  to: "architect" | "human" | "platform";
  attempt: number;
  reason: string;
  cases: string[];
  at: number;
}

/** 同一失败签名累计第三次原样复现 —— 修复连修两轮未生效或疑似测试基础设施异常,审计并终止修复循环。 */
export interface InfraSuspectRecord {
  seq: number;
  at: number;
  attempt: number;
  cases: string[];
  signature: string;
}

/** 同一失败签名第二次原样复现 —— 修复未生效,保持原责任人再修一次。 */
export interface FixIneffectiveRecord {
  seq: number;
  at: number;
  attempt: number;
  cases: string[];
  signature: string;
}

/** 静态质量审计(计时器生命周期)发现源码级问题 —— Cody 修复的确定性证据。 */
export interface AuditRecord {
  seq: number;
  at: number;
  attempt: number;
  round: number;
  reasons: string[];
  files: string[];
}

/** 静态审计在修复次数上限内仍未通过 —— 已继续交 Tess 运行验证,runner 硬门兜底。 */
export interface AuditExhaustedRecord {
  seq: number;
  at: number;
  attempt: number;
  reasons: string[];
}

/**
 * QA 测试计划覆盖修订 —— Tess 产出的用例在 runTests 前没覆盖场景难点,
 * 缺覆盖的语义已回喂她重写。每次重写都是一条可审计证据。
 */
export interface QaCoverageRetryRecord {
  seq: number;
  at: number;
  attempt: number;
  round: number;
  missing: string[];
}

/** 产品负责人交付验收结论 —— 功能之外的可交付判断。 */
export interface AcceptRecord {
  seq: number;
  at: number;
  attempt: number;
  accepted: boolean;
  dimensions: {
    functional: { ok: boolean; note: string };
    usability: { ok: boolean; note: string };
    visual: { ok: boolean; note: string };
  };
  issues: { dimension: "usability" | "visual"; problem: string; expectation: string }[];
  hardIssues: string[];
  summary: string;
}

export interface DispatchRecord {
  seq: number;
  at: number;
  round: number;
  next: NodeId | "ask_human" | "done";
  reason: string;
  brief: string;
  budget: { dispatches: number; maxDispatches: number };
}

export interface GateRecord {
  seq: number;
  at: number;
  gate: string;
  trigger: string;
  ok: boolean;
  blocking: boolean;
  facts: string[];
  durationMs: number;
}

export interface BudgetRecord {
  seq: number;
  at: number;
  dispatches: number;
  maxDispatches: number;
  sameRoleStreak: number;
  tokens: number;
  costUsd: number;
}

export interface ScreenProbeRecord {
  seq: number;
  at: number;
  ok: boolean;
  layers: number;
  clickables: string[];
  inputs: string[];
  regions: string[];
  openedVia?: string;
  createdVia?: string;
}

export interface ChatTurn {
  seq: number;
  turn: number;
  /** 用户说了什么 */
  text: string;
  at: number;
  /** Ida 对这条需求的分类与角色路由结论 */
  assessment?: ChangeAssessment;
  routeSeq?: number;
  /** 工程师改完之后的说明与改动文件;未完成时为空 */
  summary?: string;
  /** 说明这条消息自己的事件序号 —— 它产生在整轮迭代结束时,不能借用提问的序号 */
  doneSeq?: number;
  changed?: string[];
  outcome?: "succeeded" | "stopped";
}

export interface FileDiff {
  path: string;
  before: string;
  after: string;
}

export interface RunState {
  prompt: string;
  model: string;
  label?: string;
  /** 时间轴条目,按发生顺序;同一节点重跑会追加新条目 */
  timeline: NodeState[];
  prd?: Prd;
  design?: Design;
  /** Luna 输出的视觉语言与页面构图，Cody 必须消费这份方案。 */
  visual?: VisualDesign;
  /** 测试工程师写的验收用例 —— 与 PRD、设计并列的一等产物 */
  testCases?: TestCase[];
  files: GeneratedFile[];
  attempt: number;
  verifyHistory: VerifyRecord[];
  buildHistory: BuildRecord[];
  /** 功能级验收测试的历次结果 */
  qaHistory: QaRecord[];
  /** Ida 对 QA 失败的历次归因与分配 —— 组织闭环的可审计证据 */
  qaTriages: QaTriageRecord[];
  /** 责任升级记录 —— 谁被拉进来了、为什么 */
  escalations: Escalation[];
  /** 疑似测试基础设施问题 —— 同一失败签名累计第三次原样复现的审计记录 */
  infraSuspects: InfraSuspectRecord[];
  /** 修复未生效 —— 同一失败签名第二次复现,保持原责任人再修一次的记录 */
  fixIneffective: FixIneffectiveRecord[];
  /** 静态质量审计(计时器生命周期)记录 */
  audits: AuditRecord[];
  /** 静态审计修复次数上限内仍未通过 */
  auditExhausted: AuditExhaustedRecord[];
  /** QA 测试计划覆盖修订记录 —— runTests 前缺覆盖语义回喂 Tess 重写 */
  qaCoverageRetries: QaCoverageRetryRecord[];
  /** Ida 的历次交付验收 —— 功能通过之后「能不能交出去」的判断 */
  accepts: AcceptRecord[];
  /** Piper 每一次派单及理由。 */
  dispatches: DispatchRecord[];
  /** 平台门禁的事实判定。 */
  gates: GateRecord[];
  /** 每轮派单后的真实预算快照。 */
  budgetHistory: BudgetRecord[];
  /** Tess 写用例前看到的真实界面控件。 */
  screenProbes: ScreenProbeRecord[];
  /** 首轮生成之后的历次对话迭代 */
  chat: ChatTurn[];
  /** 已经进行到第几轮迭代(0 = 只有首轮生成) */
  turn: number;
  /** 最近一次构建成功的产物体积,用于在 UI 上展示「交付了多大的东西」 */
  bundleBytes?: number;
  fixDiffs: { attempt: number; changed: FileDiff[] }[];
  /** 结构化产物被解析打回并修正的总次数(run 级聚合) */
  parseRetries: number;
  totals: Usage;
  awaiting: "approval" | "verify" | null;
  hitl: { decision: "approved" | "rejected"; edited: boolean } | null;
  finished: "succeeded" | "failed" | null;
  aborted: string | null;
  lastSeq: number;
}

export function emptyState(): RunState {
  return {
    prompt: "",
    model: "",
    timeline: [],
    files: [],
    attempt: 0,
    verifyHistory: [],
    buildHistory: [],
    qaHistory: [],
    qaTriages: [],
    escalations: [],
    infraSuspects: [],
    fixIneffective: [],
    audits: [],
    auditExhausted: [],
    qaCoverageRetries: [],
    accepts: [],
    dispatches: [],
    gates: [],
    budgetHistory: [],
    screenProbes: [],
    chat: [],
    turn: 0,
    fixDiffs: [],
    parseRetries: 0,
    totals: { ...EMPTY_USAGE },
    awaiting: null,
    hitl: null,
    finished: null,
    aborted: null,
    lastSeq: -1,
  };
}

/** 取时间轴上最后一个仍在运行的指定节点 */
function activeNode(s: RunState, id: NodeId): NodeState | undefined {
  for (let i = s.timeline.length - 1; i >= 0; i--) {
    if (s.timeline[i].id === id && s.timeline[i].phase === "running") return s.timeline[i];
  }
  return undefined;
}

/**
 * 应用单条事件。**就地修改**并返回同一对象 —— 这是刻意的:
 * 一次生成会产生数千条 token 级事件,每条都做不可变拷贝会让 UI 掉帧。
 * 调用方通过 lastSeq 变化来触发重渲染。
 */
export function applyEvent(s: RunState, env: Envelope<RunEvent>): RunState {
  const e = env.event;
  s.lastSeq = env.seq;

  switch (e.type) {
    case "run.started":
      s.prompt = e.prompt;
      s.model = e.model;
      s.label = e.label;
      break;

    case "node.started":
      s.timeline.push({
        seq: env.seq,
        id: e.node,
        phase: "running",
        model: e.model,
        role: e.role,
        reasoning: "",
        content: "",
        usage: { ...EMPTY_USAGE },
        durationMs: 0,
        startedAt: env.ts,
        prompt: "",
        raw: "",
        runIndex: s.timeline.filter((n) => n.id === e.node).length,
      });
      break;

    case "node.reasoning.delta": {
      const n = activeNode(s, e.node);
      if (n) n.reasoning += e.text;
      break;
    }

    case "node.content.delta": {
      const n = activeNode(s, e.node);
      if (n) n.content += e.text;
      break;
    }

    case "node.finished": {
      const n = activeNode(s, e.node);
      if (n) {
        n.phase = "done";
        n.usage = e.usage;
        n.durationMs = e.durationMs;
        n.prompt = e.prompt;
        n.raw = e.raw;
        // 新运行不再保存 token 级 delta，最终正文随 node.finished 一次落盘。
        // 历史运行的 reasoning 仍由旧 delta 事件兼容回放。
        n.content = e.raw || n.content;
      }
      s.totals = addUsage(s.totals, e.usage);
      break;
    }

    case "node.retry": {
      const n = activeNode(s, e.node);
      if (n) n.retries = (n.retries ?? 0) + 1;
      break;
    }

    case "node.thinking_degrade": {
      const n = activeNode(s, e.node);
      if (n) {
        (n.thinkingDegrades ??= []).push({
          attempt: e.attempt,
          reason: e.reason,
          from: e.from,
          to: e.to,
          ...(e.wastedTokens !== undefined ? { wastedTokens: e.wastedTokens } : {}),
          ...(e.wastedCostUsd !== undefined ? { wastedCostUsd: e.wastedCostUsd } : {}),
        });
      }
      break;
    }

    case "node.failed": {
      const n = activeNode(s, e.node);
      if (n) {
        n.phase = "failed";
        n.error = e.error;
      }
      // 失败的调用也可能已经消费了 token/成本(如推理空转被掐断的尝试),
      // 不能因为节点失败就让耗用从成本面板里消失
      if (e.usage) s.totals = addUsage(s.totals, e.usage);
      break;
    }

    // 结构化产物被解析打回:该次调用本身完成了,但结果不可用,
    // 把被拒绝的那次尝试标红、记修正序数并附解析错误 —— 审计能看出角色被修正了几次。
    // artifact.rejected 是旧事件名,与 node.parse_retry 同构,历史 run 回放必须继续消费,
    // 因此两个 case 走同一个分支并同样计入 parseRetries。
    case "node.parse_retry":
    case "artifact.rejected": {
      s.parseRetries += 1;
      const ordinal = s.timeline.filter((x) => x.id === e.node).length;
      for (let i = s.timeline.length - 1; i >= 0; i--) {
        const n = s.timeline[i];
        if (n.id === e.node) {
          n.phase = "failed";
          n.parseRetries = ordinal;
          n.error = `结构化产物未通过解析(第 ${e.attempt} 次),已回喂重写:${e.reason}`;
          break;
        }
      }
      break;
    }

    case "artifact":
      applyArtifact(s, e.kind, e.data);
      break;

    case "dispatch.decided":
      s.dispatches.push({
        seq: env.seq,
        at: env.ts,
        round: e.round,
        next: e.next,
        reason: e.reason,
        brief: e.brief,
        budget: e.budget,
      });
      break;

    case "gate.verdict":
      s.gates.push({
        seq: env.seq,
        at: env.ts,
        gate: e.gate,
        trigger: e.trigger,
        ok: e.ok,
        blocking: e.blocking,
        facts: e.facts,
        durationMs: e.durationMs,
      });
      break;

    case "budget.spent":
      s.budgetHistory.push({
        seq: env.seq,
        at: env.ts,
        dispatches: e.dispatches,
        maxDispatches: e.maxDispatches,
        sameRoleStreak: e.sameRoleStreak,
        tokens: e.tokens,
        costUsd: e.costUsd,
      });
      break;

    case "screen.probed":
      s.screenProbes.push({
        seq: env.seq,
        at: env.ts,
        ok: e.ok,
        layers: e.layers,
        clickables: e.clickables,
        inputs: e.inputs,
        regions: e.regions,
        openedVia: e.openedVia,
        createdVia: e.createdVia,
      });
      break;

    case "hitl.awaiting":
      s.awaiting = "approval";
      break;

    case "hitl.resolved":
      s.awaiting = null;
      s.hitl = { decision: e.decision, edited: e.edited };
      break;

    case "chat.user":
      s.chat.push({ seq: env.seq, turn: e.turn, text: e.text, at: env.ts });
      s.turn = e.turn;
      // 新一轮已经开始,上一轮的“已交付”不能继续覆盖当前生成/验证状态。
      s.finished = null;
      s.aborted = null;
      break;

    case "chat.routed": {
      const t = s.chat.find((c) => c.turn === e.turn);
      if (t) {
        t.assessment = e.assessment;
        t.routeSeq = env.seq;
      }
      break;
    }

    case "chat.done": {
      const t = s.chat.find((c) => c.turn === e.turn);
      if (t) {
        t.summary = e.summary;
        t.changed = e.changed;
        t.outcome = e.outcome;
        t.doneSeq = env.seq;
      }
      break;
    }

    case "qa.triage":
      s.qaTriages.push({
        seq: env.seq,
        at: env.ts,
        attempt: e.attempt,
        triage: e.triage,
      });
      break;

    case "qa.coverage_retry":
      s.qaCoverageRetries.push({
        seq: env.seq,
        at: env.ts,
        attempt: e.attempt,
        round: e.round,
        missing: e.missing,
      });
      break;

    case "escalated":
      s.escalations.push({
        seq: env.seq,
        to: e.to,
        attempt: e.attempt,
        reason: e.reason,
        cases: e.cases,
        at: env.ts,
      });
      break;

    case "qa.infrastructure_suspected":
      s.infraSuspects.push({
        seq: env.seq,
        at: env.ts,
        attempt: e.attempt,
        cases: e.cases,
        signature: e.signature,
      });
      break;

    case "qa.fix_ineffective":
      s.fixIneffective.push({
        seq: env.seq,
        at: env.ts,
        attempt: e.attempt,
        cases: e.cases,
        signature: e.signature,
      });
      break;

    case "audit.failed":
      s.audits.push({
        seq: env.seq,
        at: env.ts,
        attempt: e.attempt,
        round: e.round,
        reasons: e.reasons,
        files: e.files,
      });
      break;

    case "audit.exhausted":
      s.auditExhausted.push({
        seq: env.seq,
        at: env.ts,
        attempt: e.attempt,
        reasons: e.reasons,
      });
      break;

    case "qa.started":
      s.awaiting = null;
      break;

    case "qa.result":
      s.qaHistory.push({
        seq: env.seq,
        at: env.ts,
        attempt: e.attempt,
        passed: e.passed,
        failed: e.failed,
        durationMs: e.durationMs,
        cases: e.cases,
      });
      break;

    case "build.started":
      s.awaiting = null;
      break;

    case "build.result":
      s.buildHistory.push({
        seq: env.seq,
        at: env.ts,
        attempt: e.attempt,
        ok: e.ok,
        bytes: e.bytes,
        durationMs: e.durationMs,
        errors: e.errors,
      });
      if (e.ok && e.bytes) s.bundleBytes = e.bytes;
      break;

    case "accept.started":
      s.awaiting = null;
      break;

    case "accept.result":
      s.accepts.push({
        seq: env.seq,
        at: env.ts,
        attempt: e.attempt,
        accepted: e.accepted,
        dimensions: e.dimensions,
        issues: e.issues,
        hardIssues: e.hardIssues,
        summary: e.summary,
      });
      break;

    case "verify.started":
      // 这是一个真正的可恢复等待点:服务端已完成产物,正在等浏览器探针回报。
      // 历史回放或刷新页面后也必须能恢复到 verifying,不能退回 generating。
      s.awaiting = "verify";
      s.attempt = e.attempt;
      break;

    case "verify.result":
      s.verifyHistory.push({ attempt: e.attempt, ok: e.ok, issues: e.issues });
      s.awaiting = null;
      break;

    case "fix.started":
      s.attempt = e.attempt;
      break;

    case "fix.diff":
      s.fixDiffs.push({ attempt: e.attempt, changed: e.changed });
      break;

    case "run.finished":
      s.finished = e.status;
      s.awaiting = null;
      break;

    case "run.aborted":
      s.aborted = e.reason;
      s.awaiting = null;
      break;
  }
  return s;
}

function applyArtifact(s: RunState, kind: ArtifactKind, data: unknown) {
  if (kind === "prd") s.prd = data as Prd;
  else if (kind === "design") s.design = data as Design;
  else if (kind === "visual") s.visual = data as VisualDesign;
  else if (kind === "tests") s.testCases = data as TestCase[];
  else if (kind === "files") {
    // 修复阶段只回传改动过的文件,这里做覆盖式合并而不是整体替换
    const incoming = data as GeneratedFile[];
    const map = new Map(s.files.map((f) => [f.path, f]));
    for (const f of incoming) map.set(f.path, f);
    s.files = [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
}

/**
 * 就地清空。
 * 保持对象身份不变很重要:上层把这个对象当成稳定引用持有,
 * 换成新对象会让所有持有者拿到过期快照。
 */
export function resetState(s: RunState): RunState {
  Object.assign(s, emptyState());
  return s;
}

/** 从零折叠整个事件流 */
export function foldEvents(events: Envelope<RunEvent>[]): RunState {
  const s = emptyState();
  for (const e of events) applyEvent(s, e);
  return s;
}

/** 回放:折叠前 n 条 */
export function foldUpTo(events: Envelope<RunEvent>[], n: number): RunState {
  return foldEvents(events.slice(0, Math.max(0, Math.min(n, events.length))));
}

/**
 * 是否发生过结构改进 —— 构建自愈 / 修复轮 / QA 重跑 / 结构化产物被解析修正。
 * 纯函数,供 runner 与 UI 共用同一份判定,避免「观测口径」两处漂移。
 */
export function structureChanged(s: RunState): boolean {
  const buildRetries = Math.max(0, s.buildHistory.length - 1);
  return (
    buildRetries > 0 ||
    s.fixDiffs.length > 0 ||
    s.qaHistory.length > 1 ||
    s.parseRetries > 0 ||
    // 静态审计引发的修复同样是结构级改动 —— 源码在交付前被改写
    s.audits.length > 0
  );
}
