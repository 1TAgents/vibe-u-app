"use client";

/**
 * 项目列表。
 *
 * 设计上的一个明确取舍:**不为「会话」再造一个概念**。
 * 一次 run 的事件流本身就是完整的会话日志 —— 首轮生成、人的批准、
 * 历次对话迭代、每一次失败与自愈,全都按序追加在同一条流里。
 * 所以 run 就是项目,不需要在它之上再包一层。
 *
 * 同一个项目有两个入口,对应两种意图:
 *   继续改 → 工作区(可编辑,带对话)
 *   回放 → 只读时间轴(给别人看的)
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { cn, fmtUsd } from "@/lib/cn";

export interface RunSummary {
  id: string;
  prompt: string;
  model: string;
  label: string | null;
  status: string;
  totals: { totalTokens: number; costUsd: number };
  createdAt: number;
  updatedAt: number;
}

const STATUS: Record<string, { text: string; dot: string; cls: string }> = {
  succeeded: { text: "已交付", dot: "bg-emerald-400", cls: "text-emerald-300" },
  running: { text: "进行中", dot: "bg-amber-400", cls: "text-amber-300" },
  awaiting_approval: { text: "待批准", dot: "bg-violet-400", cls: "text-violet-300" },
  failed: { text: "失败", dot: "bg-rose-400", cls: "text-rose-300" },
  aborted: { text: "已中断", dot: "bg-ink-600", cls: "text-ink-400" },
};

/** 一次跑批会留下几十条记录,不筛一下没法看 —— 默认只看能打开的那些 */
const FILTERS = [
  { id: "usable", text: "能打开", match: (s: string) => s === "succeeded" },
  { id: "all", text: "全部", match: () => true },
  { id: "failed", text: "没成", match: (s: string) => s === "failed" || s === "aborted" },
] as const;

export function ProjectList({ runs }: { runs: RunSummary[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("usable");
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[1];
    const kw = q.trim().toLowerCase();
    return runs.filter(
      (r) =>
        f.match(r.status) &&
        (kw === "" ||
          `${r.label ?? ""} ${r.prompt}`.toLowerCase().includes(kw)),
    );
  }, [runs, filter, q]);

  if (runs.length === 0) return null;

  return (
    <section className="mt-16 max-w-4xl border-t border-ink-800/80 pt-7">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-ink-300">
          最近项目
          <span className="ml-2 rounded-full bg-ink-850 px-2 py-0.5 font-mono text-[10px] font-normal text-ink-500">
            {shown.length}
            {shown.length !== runs.length && ` / ${runs.length}`}
          </span>
        </h2>

        {runs.length > 3 && <div className="ml-auto flex items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded-lg px-2 py-1 text-[11px] transition-colors",
                filter === f.id
                  ? "bg-ink-700 text-ink-100"
                  : "text-ink-500 hover:text-ink-300",
              )}
            >
              {f.text}
            </button>
          ))}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜项目名"
            aria-label="搜索项目"
            className="w-28 rounded-lg border border-ink-800 bg-ink-900/60 px-2 py-1 text-[11px] text-ink-200 outline-none placeholder:text-ink-600 focus:border-ink-700"
          />
        </div>}
      </div>

      {shown.length === 0 && (
        <p className="mt-3 text-[12px] text-ink-500">没有符合条件的项目。</p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {shown.map((r) => {
          const st = STATUS[r.status] ?? STATUS.running;
          return (
            <div
              key={r.id}
              className="group flex flex-col rounded-xl border border-ink-800 bg-ink-900/45 p-4 transition-all hover:-translate-y-0.5 hover:border-ink-700 hover:bg-ink-900/70"
            >
              <div className="flex items-start gap-2">
                <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", st.dot)} />
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-[14px] font-medium text-ink-200">
                    {r.label || r.prompt}
                  </h3>
                  {r.label && (
                    <p className="mt-0.5 truncate text-[11px] text-ink-500" title={r.prompt}>
                      {r.prompt}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] text-ink-600">
                <span className={st.cls}>{st.text}</span>
                <span>{r.model}</span>
                <span>{fmtUsd(r.totals?.costUsd ?? 0)}</span>
                <span className="ml-auto">{ago(r.updatedAt || r.createdAt)}</span>
              </div>

              <div className="mt-3 flex items-center gap-1.5">
                <Link
                  href={`/workspace?run=${r.id}`}
                  className="rounded-lg bg-ink-800 px-2.5 py-1.5 text-[11px] text-ink-200 transition-colors hover:bg-ink-700"
                >
                  继续改
                </Link>
                <Link
                  href={`/r/${r.id}`}
                  className="ml-auto text-[11px] text-ink-500 transition-colors hover:text-ink-300"
                >
                  回放
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ago(ts: number): string {
  const s = Math.max(0, Date.now() - ts) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
