"use client";

/**
 * 成本面板。
 *
 * 把 token 与美元实时摆在最显眼的位置,是一个刻意的产品判断:
 * agent 系统真正的运营风险不是"跑不出来",而是"跑出来了但没人知道花了多少"。
 * 一个不敢展示自己成本的 agent 产品,是不打算被认真使用的。
 */

import { cn, fmtTokens, fmtUsd } from "@/lib/cn";
import { isPricingKnown } from "@/lib/llm";
import type { RunState } from "@/lib/fold";
import type { Phase } from "@/lib/useRun";

const PHASE_LABEL: Record<Phase, { text: string; cls: string }> = {
  idle: { text: "待命", cls: "bg-ink-800 text-ink-400" },
  generating: { text: "生成中", cls: "bg-sky-500/15 text-sky-300" },
  awaiting_approval: { text: "等待你批准", cls: "bg-violet-500/15 text-violet-300" },
  verifying: { text: "运行时校验中", cls: "bg-amber-500/15 text-amber-300" },
  fixing: { text: "自愈修复中", cls: "bg-rose-500/15 text-rose-300" },
  succeeded: { text: "已交付", cls: "bg-emerald-500/15 text-emerald-300" },
  failed: { text: "失败", cls: "bg-rose-500/20 text-rose-300" },
};

export function CostBar({
  state,
  phase,
  onAbort,
}: {
  state: RunState;
  phase: Phase;
  onAbort?: () => void;
}) {
  const p = PHASE_LABEL[phase];
  const busy = phase === "generating" || phase === "fixing";
  const estimated = state.model !== "" && !isPricingKnown(state.model);
  const wall = state.timeline.reduce((n, t) => n + t.durationMs, 0);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium", p.cls)}>
        {busy && <span className="mr-1.5 inline-block size-1.5 rounded-full bg-current pulse-dot" />}
        {p.text}
      </span>

      <Metric label="模型调用" value={String(state.timeline.length)} />
      <Metric label="累计 token" value={fmtTokens(state.totals.totalTokens)} />
      <Metric
        label="思考 token"
        value={fmtTokens(state.totals.reasoningTokens)}
        hint="推理模型用于思考、未出现在最终产物里的 token"
      />
      <Metric label="模型耗时" value={`${(wall / 1000).toFixed(1)}s`} />
      <Metric
        label="成本"
        value={fmtUsd(state.totals.costUsd) + (estimated ? " *" : "")}
        hint={estimated ? "该模型无内置价目,按缺省单价估算" : undefined}
        emphasis
      />

      {onAbort && busy && (
        <button
          onClick={onAbort}
          className="ml-auto rounded border border-ink-700 px-2.5 py-1 text-[11px] text-ink-300 transition-colors hover:border-rose-500/50 hover:text-rose-300"
        >
          中断
        </button>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5" title={hint}>
      <span className="text-[11px] text-ink-400">{label}</span>
      <span
        className={cn(
          "font-mono text-xs",
          emphasis ? "text-emerald-300" : "text-ink-200",
        )}
      >
        {value}
      </span>
    </div>
  );
}
