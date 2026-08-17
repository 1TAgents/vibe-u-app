"use client";

import { cn } from "@/lib/cn";
import { buildDeliverySummary } from "@/lib/delivery-summary";
import type { RunState } from "@/lib/fold";

const STATUS = {
  ready: {
    text: "证据齐备，可以交付",
    dot: "bg-emerald-400",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  },
  blocked: {
    text: "仍有问题，暂不交付",
    dot: "bg-rose-400",
    badge: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  },
  in_progress: {
    text: "证据收集中",
    dot: "bg-amber-400",
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  },
} as const;

export function DeliverySummary({ state }: { state: RunState }) {
  const summary = buildDeliverySummary(state);
  const status = STATUS[summary.status];

  return (
    <section className="overflow-hidden rounded-2xl border border-ink-700 bg-[linear-gradient(145deg,rgba(15,23,42,0.94),rgba(7,12,22,0.98))] shadow-[0_24px_60px_rgba(0,0,0,0.18)]">
      <header className="flex flex-wrap items-start gap-3 border-b border-ink-800 px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span className={cn("size-2 rounded-full", status.dot)} />
            <h2 className="text-[15px] font-semibold text-ink-100">交付摘要</h2>
            <span className={cn("rounded-full border px-2 py-0.5 text-[10px]", status.badge)}>
              {status.text}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
            从产品承诺到真实执行结果；结论来自平台证据，不来自角色自述。
          </p>
        </div>
        <div className="ml-auto grid grid-cols-3 divide-x divide-ink-800 overflow-hidden rounded-lg border border-ink-800 bg-ink-950/40">
          <Metric label="P0 覆盖" value={`${summary.p0Covered}/${summary.p0Total}`} />
          <Metric label="用例通过" value={`${summary.passedTests}/${summary.totalTests}`} />
          <Metric label="证据通过" value={`${summary.passedEvidence}/4`} />
        </div>
      </header>

      <div className="grid gap-px bg-ink-800 lg:grid-cols-2">
        <SummaryBlock index="01" title="本次承诺" subtitle="Ida · PRD">
          {summary.promises.length === 0 ? (
            <Empty>PRD 尚未形成，暂时没有可核对的承诺。</Empty>
          ) : (
            <ul className="space-y-2">
              {summary.promises.map((item) => (
                <li key={item.name} className="flex items-start gap-2.5">
                  <span className={cn(
                    "mt-0.5 rounded px-1.5 py-px font-mono text-[9px]",
                    item.priority === "P0"
                      ? "bg-violet-500/15 text-violet-300"
                      : "bg-ink-800 text-ink-500",
                  )}>
                    {item.priority}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-ink-200">{item.name}</span>
                      <span className={cn(
                        "text-[9px]",
                        item.testedBy.length > 0 ? "text-emerald-400" : "text-amber-400",
                      )}>
                        {item.testedBy.length > 0 ? "已映射验收" : "未覆盖"}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-ink-500">
                      {item.description}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SummaryBlock>

        <SummaryBlock index="02" title="实际验收" subtitle="Tess · 最后一轮">
          {summary.tests.length === 0 ? (
            <Empty>验收计划尚未写定。</Empty>
          ) : (
            <ul className="space-y-2">
              {summary.tests.map((item) => (
                <li key={item.name} className="flex items-start gap-2">
                  <StatusMark status={item.status} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] leading-relaxed text-ink-200">{item.name}</p>
                    <p className={cn(
                      "mt-0.5 truncate text-[10px]",
                      item.status === "failed" ? "text-rose-300/80" : "text-ink-500",
                    )} title={item.reason ?? item.covers.join("、")}>
                      {item.reason || (item.covers.length > 0 ? `覆盖：${item.covers.join("、")}` : "未声明覆盖项")}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SummaryBlock>

        <SummaryBlock index="03" title="客观证据" subtitle="平台质量门">
          <div className="grid gap-2 sm:grid-cols-2">
            {summary.evidence.map((item) => (
              <div key={item.id} className="rounded-lg border border-ink-800 bg-ink-950/30 px-2.5 py-2">
                <div className="flex items-center gap-1.5">
                  <StatusMark status={item.status} compact />
                  <span className="text-[11px] text-ink-300">{item.label}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-ink-500" title={item.detail}>
                  {item.detail}
                </p>
              </div>
            ))}
          </div>
        </SummaryBlock>

        <SummaryBlock index="04" title="已知边界" subtitle="不把未测当已测">
          <ul className="space-y-2">
            {summary.boundaries.map((item, index) => (
              <li key={index} className="flex items-start gap-2 text-[10px] leading-relaxed">
                <span className={cn(
                  "mt-[5px] size-1.5 shrink-0 rounded-full",
                  item.tone === "warning" ? "bg-amber-400" : "bg-ink-600",
                )} />
                <span className={item.tone === "warning" ? "text-amber-200/80" : "text-ink-500"}>
                  {item.text}
                </span>
              </li>
            ))}
          </ul>
        </SummaryBlock>
      </div>
    </section>
  );
}

function SummaryBlock({
  index,
  title,
  subtitle,
  children,
}: {
  index: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-h-44 bg-ink-900/85 px-4 py-4">
      <header className="mb-3 flex items-baseline gap-2">
        <span className="font-mono text-[9px] text-emerald-400/70">{index}</span>
        <h3 className="text-[12px] font-medium text-ink-200">{title}</h3>
        <span className="ml-auto text-[9px] text-ink-600">{subtitle}</span>
      </header>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-20 px-3 py-2 text-center">
      <div className="font-mono text-[13px] text-ink-200">{value}</div>
      <div className="mt-0.5 text-[9px] text-ink-600">{label}</div>
    </div>
  );
}

function StatusMark({
  status,
  compact = false,
}: {
  status: "passed" | "failed" | "pending";
  compact?: boolean;
}) {
  return (
    <span className={cn(
      "flex shrink-0 items-center justify-center rounded-full border font-mono",
      compact ? "size-4 text-[9px]" : "mt-0.5 size-4.5 text-[10px]",
      status === "passed"
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
        : status === "failed"
          ? "border-rose-500/30 bg-rose-500/10 text-rose-400"
          : "border-ink-700 bg-ink-800 text-ink-500",
    )}>
      {status === "passed" ? "✓" : status === "failed" ? "×" : "·"}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-[11px] text-ink-600">{children}</p>;
}
