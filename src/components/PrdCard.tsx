"use client";

/**
 * PRD 卡片 + HITL 审批门。
 *
 * 这里的人在回路不是"批准 / 拒绝"两个按钮:用户可以**直接改写 PRD** 再放行,
 * 改写后的版本会作为新事件进入事件流,下游架构师消费的是用户改过的那一版。
 * 只能点"同意"的审批门不是人在回路,是一个仪式。
 */

import { useState } from "react";
import type { Prd } from "@/lib/roles";
import { cn } from "@/lib/cn";

export function PrdCard({
  prd,
  awaiting,
  decided,
  onApprove,
  onReject,
}: {
  prd: Prd;
  awaiting: boolean;
  decided: { decision: "approved" | "rejected"; edited: boolean } | null;
  onApprove: (prd: Prd) => void;
  onReject: () => void;
}) {
  const [draft, setDraft] = useState<Prd>(prd);
  const [editing, setEditing] = useState(false);
  const [syncedFrom, setSyncedFrom] = useState<Prd>(prd);

  // 上游产出了新 PRD 时同步草稿 —— 但用户正在编辑就不能覆盖,那是在冲掉人的输入。
  // 用渲染期状态调整而不是 useEffect:后者会先用旧数据画一帧再纠正,产生可见的闪烁。
  if (prd !== syncedFrom && !editing) {
    setSyncedFrom(prd);
    setDraft(prd);
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(prd);

  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900/60">
      <header className="flex items-center gap-2 border-b border-ink-800 px-4 py-3">
        <span className="size-2 rounded-full bg-violet-400" />
        <h2 className="text-sm font-medium text-ink-200">产品需求文档</h2>
        <span className="text-[11px] text-ink-400">Emma · 产品负责人</span>
        {decided && (
          <span
            className={cn(
              "ml-auto rounded-full px-2 py-0.5 text-[11px]",
              decided.decision === "approved"
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-rose-500/15 text-rose-300",
            )}
          >
            {decided.decision === "approved"
              ? decided.edited
                ? "已批准(用户改写过)"
                : "已批准"
              : "已驳回"}
          </span>
        )}
        {awaiting && (
          <button
            onClick={() => setEditing((v) => !v)}
            className="ml-auto rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-300 hover:border-ink-600 hover:text-ink-200"
          >
            {editing ? "完成编辑" : "接管修改"}
          </button>
        )}
      </header>

      <div className="space-y-4 px-4 py-4">
        <Field
          label="产品名"
          value={draft.title}
          editing={editing}
          onChange={(v) => setDraft({ ...draft, title: v })}
          className="text-lg font-medium text-ink-200"
        />
        <Field
          label="一句话价值"
          value={draft.oneLiner}
          editing={editing}
          onChange={(v) => setDraft({ ...draft, oneLiner: v })}
          className="text-sm text-ink-300"
        />

        <div>
          <Label>目标用户</Label>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {draft.targetUsers.map((u, i) => (
              <span
                key={i}
                className="rounded-full border border-ink-700 px-2.5 py-1 text-[11px] text-ink-300"
              >
                {u}
              </span>
            ))}
          </div>
        </div>

        <div>
          <Label>核心功能</Label>
          <ul className="mt-1.5 space-y-1.5">
            {draft.coreFeatures.map((f, i) => (
              <li
                key={i}
                className="flex gap-2.5 rounded-lg border border-ink-800 bg-ink-850/50 px-3 py-2"
              >
                <span className="mt-0.5 shrink-0 rounded bg-ink-800 px-1.5 py-px font-mono text-[10px] text-ink-400">
                  {f.priority}
                </span>
                <div className="min-w-0 flex-1">
                  <Field
                    label=""
                    value={f.name}
                    editing={editing}
                    onChange={(v) => {
                      const next = [...draft.coreFeatures];
                      next[i] = { ...next[i], name: v };
                      setDraft({ ...draft, coreFeatures: next });
                    }}
                    className="text-[13px] font-medium text-ink-200"
                  />
                  <Field
                    label=""
                    value={f.description}
                    editing={editing}
                    multiline
                    onChange={(v) => {
                      const next = [...draft.coreFeatures];
                      next[i] = { ...next[i], description: v };
                      setDraft({ ...draft, coreFeatures: next });
                    }}
                    className="mt-0.5 text-xs leading-relaxed text-ink-400"
                  />
                </div>
                {editing && (
                  <button
                    onClick={() =>
                      setDraft({
                        ...draft,
                        coreFeatures: draft.coreFeatures.filter((_, j) => j !== i),
                      })
                    }
                    className="shrink-0 self-start text-ink-600 hover:text-rose-400"
                    title="删掉这个功能"
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <Label>用户流程</Label>
          <ol className="mt-1.5 space-y-1">
            {draft.userFlow.map((s, i) => (
              <li key={i} className="flex gap-2 text-xs text-ink-300">
                <span className="font-mono text-ink-600">{i + 1}.</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </div>

        {draft.nonGoals.length > 0 && (
          <div>
            <Label>本版本不做</Label>
            <p className="mt-1 text-xs text-ink-400">{draft.nonGoals.join(" · ")}</p>
          </div>
        )}
      </div>

      {awaiting && (
        <footer className="flex items-center gap-2 border-t border-ink-800 px-4 py-3">
          <button
            onClick={() => onApprove(draft)}
            className="rounded-lg bg-emerald-500/90 px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-emerald-400"
          >
            {dirty ? "用我改的版本继续" : "批准并继续"}
          </button>
          <button
            onClick={onReject}
            className="rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-300 transition-colors hover:border-rose-500/50 hover:text-rose-300"
          >
            驳回
          </button>
          <span className="ml-auto text-[11px] text-ink-500">
            {dirty ? "检测到你的改动,下游将消费改写后的版本" : "架构师会以这份 PRD 为输入"}
          </span>
        </footer>
      )}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] uppercase tracking-wide text-ink-500">{children}</span>
  );
}

function Field({
  label,
  value,
  editing,
  multiline,
  onChange,
  className,
}: {
  label: string;
  value: string;
  editing: boolean;
  multiline?: boolean;
  onChange: (v: string) => void;
  className?: string;
}) {
  if (!editing) {
    return (
      <div>
        {label && <Label>{label}</Label>}
        <p className={cn(label && "mt-1", className)}>{value}</p>
      </div>
    );
  }
  const shared = cn(
    "w-full rounded border border-ink-700 bg-ink-950/60 px-2 py-1 outline-none focus:border-violet-400/60",
    className,
  );
  return (
    <div>
      {label && <Label>{label}</Label>}
      {multiline ? (
        <textarea
          value={value}
          rows={2}
          onChange={(e) => onChange(e.target.value)}
          className={cn(shared, label && "mt-1", "resize-y")}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(shared, label && "mt-1")}
        />
      )}
    </div>
  );
}
