/**
 * 把运行状态推导成一条群聊消息流。
 *
 * 这是刻意的产品判断:**用户的指令和 agent 的工作本来就是同一场对话**,
 * 拆成「轨迹面板」和「对话框」两块是把一件事建模成了两件事。
 * 做成群聊之后,「架构师被拉进来复审」自然地表现为一句 @,
 * PDCA 循环不需要额外解释就看得懂。
 *
 * 关键约束:**群聊里那句发言不花 token 让模型写**,而是从产物里确定性推导。
 * 一是省钱,二是更重要的 —— 推导出来的话不可能撒谎。
 * 让模型自己汇报「我干了什么」,正是 Atoms 那个「说做完了但没做」的病灶。
 * 这里 Alex 说「写完了 9 个文件」,那就是真的有 9 个文件。
 */

import type { RunState } from "./fold";
import type { QaTriage } from "./events";
import { ROLES } from "./roles";

export interface FeedDetail {
  reasoning: string;
  prompt: string;
  raw: string;
  model: string;
  durationMs: number;
  tokens: number;
  costUsd: number;
}

export interface FeedItem {
  id: string;
  /** 事件流序号 —— 群聊按它排,保证与真实发生顺序完全一致 */
  seq: number;
  at: number;
  kind: "agent" | "user" | "system";
  /** 说话的人 */
  name?: string;
  title?: string;
  accent?: string;
  /** 群聊里显示的那句话 */
  text: string;
  /** 附带的小标签,比如改动的文件名、失败的用例名 */
  tags?: string[];
  tone?: "ok" | "warn" | "error";
  status?: "running" | "done" | "failed";
  /** 只有 agent 发言有:点开可审计的原始材料 */
  detail?: FeedDetail;
}

export function toFeed(state: RunState): FeedItem[] {
  const items: FeedItem[] = [];

  /* --- 角色发言 --- */
  state.timeline.forEach((n, i) => {
    const role = ROLES[n.id] ?? { name: n.id, title: n.id, accent: "ink" };
    items.push({
      id: `n${i}`,
      seq: n.seq,
      at: n.startedAt,
      kind: "agent",
      name: role.name,
      title: role.title,
      accent: role.accent,
      text:
        speak(state, n.id, n.phase, n.runIndex) +
        (n.retries ? `(网络抖动,重试了 ${n.retries} 次)` : "") +
        (n.phase === "failed" && n.parseRetries
          ? `(结构化产物修正第 ${n.parseRetries} 次)`
          : "") +
        (n.thinkingDegrades && n.thinkingDegrades.length > 0
          ? `(第${n.thinkingDegrades[0].attempt}次重试时推理空转,已关闭思考直接输出)`
          : ""),
      status: n.phase === "running" ? "running" : n.phase === "failed" ? "failed" : "done",
      tone: n.phase === "failed" ? "error" : undefined,
      detail: {
        reasoning: n.reasoning,
        prompt: n.prompt,
        raw: n.raw || n.content,
        model: n.model,
        durationMs: n.durationMs,
        tokens: n.usage.totalTokens,
        costUsd: n.usage.costUsd,
      },
    });
    if (n.error) {
      items.push({
        id: `n${i}-err`,
        seq: n.seq + 0.5,
        at: n.startedAt + 1,
        kind: "system",
        text: n.error,
        tone: "error",
      });
    }
  });

  /* --- 构建 --- */
  state.buildHistory.forEach((b, i) => {
    items.push({
      id: `b${i}`,
      seq: b.seq,
      at: b.at,
      kind: "system",
      text: b.ok
        ? `构建通过 · ${Math.round((b.bytes ?? 0) / 1024)}KB · ${b.durationMs}ms`
        : `构建失败:${(b.errors[0] ?? "").split("\n")[0].slice(0, 120)}`,
      tone: b.ok ? "ok" : "error",
    });
  });

  /* --- 验收 --- */
  state.qaHistory.forEach((q, i) => {
    const failing = q.cases.filter((c) => !c.ok);
    items.push({
      id: `q${i}`,
      seq: q.seq,
      at: q.at,
      kind: "agent",
      name: ROLES.qa.name,
      title: ROLES.qa.title,
      accent: ROLES.qa.accent,
      text:
        q.failed === 0
          ? `${q.passed} 条验收用例全部通过,功能可用`
          : `跑了 ${q.passed + q.failed} 条验收,${q.failed} 条没过`,
      tags: failing.map((c) => c.name),
      tone: q.failed === 0 ? "ok" : "error",
      status: "done",
    });
  });

  /* --- Emma 的 QA 归因与分配:Vera 报告 → Emma 分工,组织闭环在群聊里的投影 --- */
  state.qaTriages.forEach((q, i) => {
    items.push({
      id: `t${i}`,
      seq: q.seq,
      at: q.at,
      kind: "agent",
      name: ROLES.triage.name,
      title: ROLES.triage.title,
      accent: ROLES.triage.accent,
      text: triageText(q.triage),
      tags: q.triage.cases,
      status: "done",
    });
  });

  /* --- 交付验收:需求提出人对产物拍板 --- */
  state.accepts.forEach((a, i) => {
    const failing = [
      ...(a.dimensions.functional.ok ? [] : ["功能达成"]),
      ...(a.dimensions.usability.ok ? [] : ["使用习惯"]),
      ...(a.dimensions.visual.ok ? [] : ["视觉适配"]),
    ];
    items.push({
      id: `ac${i}`,
      seq: a.seq,
      at: a.at,
      kind: "agent",
      name: ROLES.accept.name,
      title: ROLES.accept.title,
      accent: ROLES.accept.accent,
      text: a.accepted
        ? `验收通过,可以交付 —— ${a.summary}`
        : `验收不通过(${failing.join("、") || "有遗留问题"}):${a.summary}`,
      tags: [
        ...a.hardIssues.map((h) => h.slice(0, 24)),
        ...a.issues.map((x) => x.problem.slice(0, 24)),
      ],
      tone: a.accepted ? "ok" : "error",
      status: "done",
    });
  });

  /* --- 责任升级:群聊里就是一句 @ --- */
  state.escalations.forEach((e, i) => {
    items.push({
      id: `e${i}`,
      seq: e.seq,
      at: e.at,
      kind: "system",
      text:
        e.to === "architect"
          ? `@${ROLES.architect.name} 这几条反复不过,帮忙看下是不是设计的问题`
          : e.to === "platform"
            ? `@平台 ${e.reason}`
            : `@你 ${e.reason}`,
      tags: e.cases,
      tone: e.to === "human" || e.to === "platform" ? "warn" : undefined,
    });
  });

  /* --- 静态质量审计:构建后、Vera 验收前拦截源码级问题,直接派 Alex 修 --- */
  state.audits.forEach((a, i) => {
    items.push({
      id: `audit${i}`,
      seq: a.seq,
      at: a.at,
      kind: "system",
      text:
        `静态审计发现计时器生命周期问题(第 ${a.round} 轮修复):${a.reasons[0]}` +
        (a.reasons.length > 1 ? ` …等共 ${a.reasons.length} 条,已派 Alex 修复` : ",已派 Alex 修复"),
      tags: a.files,
      tone: "warn",
    });
  });

  /* --- 静态审计修复次数上限用完:记录后继续交 Vera 运行验证,runner 硬门兜底 --- */
  state.auditExhausted.forEach((a, i) => {
    items.push({
      id: `auditExh${i}`,
      seq: a.seq,
      at: a.at,
      kind: "system",
      text: `静态审计修复次数上限已用完,仍存在 ${a.reasons.length} 条计时器生命周期问题 —— 交给 Vera 运行验证兜底`,
      tone: "warn",
    });
  });

  /* --- 修复未生效:同一失败签名第二次复现 —— Emma 保持原责任人再修一次,第三次才升级平台 --- */
  state.fixIneffective.forEach((f, i) => {
    items.push({
      id: `fixIneff${i}`,
      seq: f.seq,
      at: f.at,
      kind: "system",
      text: "同一失败在修复后原样复现(修复未生效)—— Emma 保持原责任人再修一次,累计第三次仍复现才升级平台",
      tags: f.cases,
      tone: "warn",
    });
  });

  /* --- 失败签名累计第三次原样复现:修复连修两轮未生效或疑似测试基础设施异常 --- */
  state.infraSuspects.forEach((s, i) => {
    items.push({
      id: `infra${i}`,
      seq: s.seq,
      at: s.at,
      kind: "system",
      text: `同一失败累计第三次原样复现(签名:${s.signature.split("\n").length} 条失败):修复连修两轮未生效或疑似测试基础设施异常,停止自动派单`,
      tags: s.cases,
      tone: "warn",
    });
  });

  /* --- QA 测试计划覆盖修订:runTests 前缺覆盖语义回喂 Vera 重写 --- */
  state.qaCoverageRetries.forEach((c, i) => {
    items.push({
      id: `cov${i}`,
      seq: c.seq,
      at: c.at,
      kind: "system",
      text: `验收测试没覆盖交付重点:${c.missing.join("、")} —— 不是产品缺陷,把缺失证据交回 Vera 重写测试计划(第 ${c.round} 轮)`,
      tags: c.missing,
      tone: "warn",
    });
  });

  /* --- 用户在群里提的要求,以及工程师的回复 --- */
  state.chat.forEach((c) => {
    items.push({ id: `u${c.turn}`, seq: c.seq, at: c.at, kind: "user", text: c.text });
    if (c.assessment) {
      const a = c.assessment;
      const reason = a.reason.replace(/[。；;，,\s]+$/u, "");
      const handoff = a.designImpact
        ? "Emma 修订 PRD,Maya 更新产品设计,再由 Bob 调整系统架构与 Alex 实现"
        : a.prdImpact
          ? "Emma 先修订 PRD,Maya 更新视觉方案,随后交给 Alex 实现"
          : a.kind === "visual"
            ? "不改 PRD 和架构,交给 Maya 调整视觉方案,再由 Alex 实现"
            : "不改 PRD 和架构,直接交给 Alex 实现";
      items.push({
        id: `u${c.turn}-route`,
        seq: c.routeSeq ?? c.seq + 0.25,
        at: c.at + 1,
        kind: "system",
        text: `Emma 判断:${reason}；${handoff}；Vera ${a.qaMode === "smoke" ? "执行既有用例冒烟回归" : "重写受影响用例并回归"}`,
      });
    }
    if (c.summary) {
      items.push({
        id: `u${c.turn}-done`,
        seq: c.doneSeq ?? c.seq + 0.5,
        at: c.at + 1,
        kind: "system",
        text: c.summary,
        tags: c.changed,
        tone: "ok",
      });
    }
  });

  /* --- 等待人确认 --- */
  if (state.awaiting === "approval") {
    items.push({
      id: "await",
      seq: Number.MAX_SAFE_INTEGER,
      at: Date.now(),
      kind: "system",
      text: "PRD 写好了,等你确认之后再往下做",
      tone: "warn",
    });
  }

  // 按事件序号排,不按时间戳 —— 同一毫秒内连发的多条事件时间戳会并列,
  // 并列时排序结果取决于插入顺序,会出现「回复排在提问前面」这种错乱。
  return items.sort((a, b) => a.seq - b.seq);
}

/** Emma 对一轮 QA 失败归因后在群里说的话 —— 全部由事件推导,不自证。 */
function triageText(t: QaTriage): string {
  const reason = t.reason.replace(/[。；;，,\s]+$/u, "");
  const msg: Record<QaTriage["cause"], string> = {
    visual: `Vera 报回的失败是视觉/信息层级问题 —— ${reason};指派 Maya 修订视觉,Alex 实现,交回 Vera 回归`,
    implementation: `Vera 报回的失败是代码实现问题 —— ${reason};指派 Alex 修复,交回 Vera 回归`,
    architecture: `Vera 报回的失败是数据模型/结构问题 —— ${reason};指派 Bob 修订设计,Alex 实现,交回 Vera 回归`,
    requirements: `Vera 报回的失败是验收口径/需求问题 —— ${reason};我来修订 PRD,再交 Alex 实现、Vera 回归`,
  };
  return msg[t.cause];
}

/**
 * 每个角色在群里会说什么。
 * 全部从已有产物推导 —— 说的是既成事实,不是自我汇报。
 */
function speak(
  state: RunState,
  node: string,
  phase: string,
  runIndex: number,
): string {
  const retry = runIndex > 0 ? "(重来一次)" : "";

  if (phase === "running") {
    const doing: Record<string, string> = {
      pm: "正在把需求拆成 PRD…",
      intake: "正在判断这条需求该交给谁…",
      pmChange: "正在把新要求更新进 PRD…",
      architect: "正在设计数据模型和页面结构…",
      architectChange: "正在评估并调整技术设计…",
      designer: "正在定义视觉语言和页面构图…",
      engineer: "正在写代码…",
      fix: "正在修…",
      iterate: "正在按你说的改…",
      qa: "正在写验收用例…",
      triage: "正在归因并分配责任…",
      review: "正在复审设计…",
    };
    return (doing[node] ?? "处理中…") + retry;
  }

  switch (node) {
    case "pm":
      return state.prd
        ? `PRD 写好了:《${state.prd.title}》,${state.prd.coreFeatures.length} 个核心功能${retry}`
        : `PRD 写好了${retry}`;

    case "intake":
      return `需求影响评估完成${retry}`;

    case "pmChange":
      return state.prd
        ? `PRD 已按新要求修订:《${state.prd.title}》${retry}`
        : `PRD 已按新要求修订${retry}`;

    case "architect":
    case "architectChange":
    case "review": {
      if (!state.design) return `设计好了${retry}`;
      const cols = state.design.dataModel.map((m) => m.name).join(" / ");
      const prefix =
        node === "review"
          ? "复审完了,调整了设计:"
          : node === "architectChange"
            ? "新需求的设计调整好了:"
            : "设计好了:";
      return `${prefix}${cols} 共 ${state.design.dataModel.length} 个集合,${state.design.pages.length} 个页面`;
    }

    case "engineer":
      return `写完了,${state.files.filter((f) => !isRuntime(f.path)).length} 个文件${retry}`;

    case "designer":
      return state.visual
        ? `视觉方案定好了:${state.visual.concept}${retry}`
        : `视觉方案定好了${retry}`;

    case "fix":
      return `改好了${retry}`;

    case "iterate":
      return `按你说的改完了${retry}`;

    case "qa":
      return `验收用例写好了${retry}`;

    default:
      return `做完了${retry}`;
  }
}

function isRuntime(path: string): boolean {
  return path === "/db.js" || path === "/index.js";
}
