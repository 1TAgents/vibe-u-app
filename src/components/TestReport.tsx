"use client";

/**
 * 测试工程师的产物模块。
 *
 * 每个角色都该有自己看得见的活儿:PM 有 PRD 卡、架构师有设计卡、
 * 工程师有代码视图 —— 而测试工程师此前只剩下几个数字,这不公平也不好用。
 *
 * 这里放两样东西:
 *   **测试用例** —— 她打算怎么验,每一步做什么。用例是在改代码之前写死的,
 *                   之后的每一轮都跑同一批,不会被"改测试让它通过"污染。
 *   **测试报告** —— 每一轮的结果、失败在第几步、当时页面上有什么。
 *
 * 报告刻意保留**历次**结果而不是只显示最后一次。一个第三轮才通过的应用
 * 和一次就过的应用,质量含义完全不同,这个信息不该被抹掉。
 */

import { cn } from "@/lib/cn";
import type { RunState } from "@/lib/fold";
import type { TestStep } from "@/lib/testrunner";
import { DeliverySummary } from "@/components/DeliverySummary";

export function TestReport({ state }: { state: RunState }) {
  const cases = state.testCases ?? [];
  const rounds = state.qaHistory;

  if (!state.prd && cases.length === 0 && rounds.length === 0 && state.accepts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-ink-500">Tess 还没开始设计质量验收</p>
      </div>
    );
  }

  const last = rounds[rounds.length - 1];
  const resultOf = (name: string) => last?.cases.find((c) => c.name === name);

  const accept = state.accepts[state.accepts.length - 1];

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <DeliverySummary state={state} />

      {/* 交付验收 —— 功能之外,产品负责人对「能不能交出去」拍板 */}
      {accept && <AcceptCard accept={accept} rounds={state.accepts.length} />}

      {/* 用例 */}
      {cases.length > 0 && (
        <section className="rounded-xl border border-ink-800 bg-ink-900/60">
          <header className="flex items-center gap-2 border-b border-ink-800 px-4 py-3">
            <span className="size-2 rounded-full bg-amber-400" />
            <h2 className="text-sm font-medium text-ink-200">验收用例</h2>
            <span className="text-[11px] text-ink-400">Tess · 质量工程师</span>
            <span className="ml-auto text-[11px] text-ink-500">
              写定后不再改动,历次都跑同一批
            </span>
          </header>

          <div className="space-y-3 px-4 py-4">
            {cases.map((c, i) => {
              const r = resultOf(c.name);
              return (
                <div
                  key={i}
                  className="overflow-hidden rounded-lg border border-ink-800 bg-ink-850/40"
                >
                  <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
                    <span
                      className={cn(
                        "font-mono text-[11px]",
                        !r ? "text-ink-500" : r.ok ? "text-emerald-400" : "text-rose-400",
                      )}
                    >
                      {!r ? "○" : r.ok ? "✓" : "✗"}
                    </span>
                    <span className="text-[13px] text-ink-200">{c.name}</span>
                    {r && !r.ok && (
                      <span className="ml-auto max-w-[55%] truncate text-[11px] text-rose-300/90">
                        {r.reason}
                      </span>
                    )}
                  </div>
                  {c.covers && c.covers.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 border-b border-ink-800/60 px-3 py-2">
                      <span className="text-[10px] text-ink-500">覆盖 P0</span>
                      {c.covers.map((feature) => (
                        <span
                          key={feature}
                          className="rounded-md border border-blue-800/60 bg-blue-950/40 px-1.5 py-0.5 text-[10px] text-blue-300"
                        >
                          {feature}
                        </span>
                      ))}
                    </div>
                  )}
                  <ol className="divide-y divide-ink-800/60">
                    {c.steps.map((s, k) => (
                      <li key={k} className="flex items-baseline gap-2 px-3 py-1.5">
                        <span className="w-4 shrink-0 font-mono text-[10px] text-ink-600">
                          {k + 1}
                        </span>
                        <StepText step={s} />
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 历次运行 */}
      {rounds.length > 0 && (
        <section className="rounded-xl border border-ink-800 bg-ink-900/60">
          <header className="flex items-center gap-2 border-b border-ink-800 px-4 py-3">
            <h2 className="text-sm font-medium text-ink-200">历次验收</h2>
            <span className="text-[11px] text-ink-400">
              失败与自愈过程一并保留
            </span>
          </header>
          <div className="divide-y divide-ink-800/60">
            {rounds.map((r, i) => (
              <div key={i} className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      r.failed === 0 ? "bg-emerald-400" : "bg-rose-400",
                    )}
                  />
                  <span className="text-[12px] text-ink-300">第 {r.attempt} 轮</span>
                  <span
                    className={cn(
                      "text-[11px]",
                      r.failed === 0 ? "text-emerald-300" : "text-rose-300",
                    )}
                  >
                    {r.passed} 通过 / {r.failed} 失败
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-ink-600">
                    {(r.durationMs / 1000).toFixed(1)}s
                  </span>
                </div>
                {r.cases.some((c) => !c.ok) && (
                  <ul className="mt-1.5 space-y-1">
                    {r.cases
                      .filter((c) => !c.ok)
                      .map((c, k) => (
                        <li key={k} className="text-[11px] leading-relaxed text-ink-400">
                          <span className="text-rose-400/80">✗</span> {c.name} —{" "}
                          {c.reason}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * 产品负责人交付验收。
 *
 * 和上面 Tess 的功能验收是两件事:Tess 回答「功能是否按 PRD 工作」,
 * 这里回答「能不能交出去」—— 包含使用习惯与视觉是否匹配目标人群的判断。
 * 用例全绿但界面难用的产品,在真实公司里同样不能交付。
 */
function AcceptCard({
  accept,
  rounds,
}: {
  accept: NonNullable<RunState["accepts"][number]>;
  rounds: number;
}) {
  const dims: { key: string; label: string; d: { ok: boolean; note: string } }[] = [
    { key: "functional", label: "功能达成", d: accept.dimensions.functional },
    { key: "usability", label: "使用习惯", d: accept.dimensions.usability },
    { key: "visual", label: "视觉适配", d: accept.dimensions.visual },
  ];

  return (
    <section
      className={cn(
        "rounded-xl border",
        accept.accepted
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-amber-500/40 bg-amber-500/5",
      )}
    >
      <header className="flex items-center gap-2.5 border-b border-ink-800/60 px-4 py-3">
        <span
          className={cn(
            "size-2 rounded-full",
            accept.accepted ? "bg-emerald-400" : "bg-amber-400",
          )}
        />
        <h2 className="text-sm font-medium text-ink-200">交付验收</h2>
        <span className="text-[11px] text-ink-400">Ida · 产品负责人</span>
        <span
          className={cn(
            "text-[12px]",
            accept.accepted ? "text-emerald-300" : "text-amber-300",
          )}
        >
          {accept.accepted ? "通过,可以交付" : "未通过"}
        </span>
        {rounds > 1 && (
          <span className="ml-auto rounded bg-ink-800 px-1.5 py-px text-[10px] text-ink-400">
            第 {rounds} 轮验收
          </span>
        )}
      </header>

      <div className="grid gap-2 px-4 py-3 sm:grid-cols-3">
        {dims.map(({ key, label, d }) => (
          <div
            key={key}
            className={cn(
              "rounded-lg border px-2.5 py-2",
              d.ok ? "border-ink-800 bg-ink-900/40" : "border-rose-500/30 bg-rose-500/5",
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className={cn("text-[11px]", d.ok ? "text-emerald-400" : "text-rose-400")}>
                {d.ok ? "✓" : "✗"}
              </span>
              <span className="text-[12px] text-ink-200">{label}</span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{d.note}</p>
          </div>
        ))}
      </div>

      {(accept.hardIssues.length > 0 || accept.issues.length > 0) && (
        <div className="space-y-1.5 border-t border-ink-800/60 px-4 py-3">
          {accept.hardIssues.map((h, i) => (
            <div key={`h${i}`} className="text-[11px] leading-relaxed text-rose-300/90">
              <span className="mr-1.5 rounded bg-rose-500/15 px-1.5 py-px text-[10px]">
                客观缺陷
              </span>
              {h}
            </div>
          ))}
          {accept.issues.map((x, i) => (
            <div key={`i${i}`} className="text-[11px] leading-relaxed text-ink-300">
              <span className="mr-1.5 rounded bg-ink-800 px-1.5 py-px text-[10px] text-ink-400">
                {x.dimension === "visual" ? "视觉" : "使用习惯"}
              </span>
              {x.problem}
              <span className="ml-1 text-ink-500">期望:{x.expectation}</span>
            </div>
          ))}
        </div>
      )}

      <p className="border-t border-ink-800/60 px-4 py-2.5 text-[11px] leading-relaxed text-ink-400">
        {accept.summary}
      </p>
    </section>
  );
}

/** 把结构化步骤翻译成人话 */
function StepText({ step }: { step: TestStep }) {
  switch (step.action) {
    case "fill":
      return (
        <span className="text-[12px] text-ink-300">
          在 <Chip>{step.target}</Chip> 里填入 <Chip>{step.value}</Chip>
        </span>
      );
    case "click":
      return (
        <span className="text-[12px] text-ink-300">
          点击 <Chip>{step.target}</Chip>
        </span>
      );
    case "expectText":
      return (
        <span className="text-[12px] text-ink-300">
          页面上应出现 <Chip tone="ok">{step.text}</Chip>
        </span>
      );
    case "expectNoText":
      return (
        <span className="text-[12px] text-ink-300">
          页面上不应再有 <Chip tone="warn">{step.text}</Chip>
        </span>
      );
    case "expectTextWithin":
      return (
        <span className="text-[12px] text-ink-300">
          在 <Chip>{step.target}</Chip> 区域内应出现 <Chip tone="ok">{step.text}</Chip>
        </span>
      );
    case "expectNoTextWithin":
      return (
        <span className="text-[12px] text-ink-300">
          在 <Chip>{step.target}</Chip> 区域内不应再有 <Chip tone="warn">{step.text}</Chip>
        </span>
      );
    case "expectValue":
      return (
        <span className="text-[12px] text-ink-300">
          <Chip>{step.target}</Chip> 的值应为 <Chip tone="ok">{step.value}</Chip>
        </span>
      );
    case "expectNumberWithin":
      return (
        <span className="text-[12px] text-ink-300">
          <Chip>{step.target}</Chip> 区域内数值应等于 <Chip tone="ok">{step.value}</Chip>
        </span>
      );
    case "expectAttribute":
      return (
        <span className="text-[12px] text-ink-300">
          <Chip>{step.target}</Chip> 的 <Chip>{step.attr}</Chip> 应为 <Chip tone="ok">{step.value}</Chip>
        </span>
      );
    case "expectNoAttribute":
      return (
        <span className="text-[12px] text-ink-300">
          <Chip>{step.target}</Chip> 的 <Chip>{step.attr}</Chip> 不应是 <Chip tone="warn">{step.value}</Chip>
        </span>
      );
  }
}

function Chip({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "ok" | "warn";
}) {
  return (
    <code
      className={cn(
        "rounded px-1.5 py-px font-mono text-[11px]",
        tone === "ok"
          ? "bg-emerald-500/10 text-emerald-300"
          : tone === "warn"
            ? "bg-amber-500/10 text-amber-300"
            : "bg-ink-800 text-ink-200",
      )}
    >
      {children}
    </code>
  );
}
