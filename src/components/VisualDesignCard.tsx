"use client";

import type { VisualDesign } from "@/lib/roles";

/** Luna 的视觉方案是一等产物，不应只埋在工程师 Prompt 里。 */
export function VisualDesignCard({ visual }: { visual: VisualDesign }) {
  const palette = [
    ["画布", visual.palette.canvas],
    ["内容层", visual.palette.surface],
    ["主操作", visual.palette.primary],
    ["强调", visual.palette.accent],
    ["文字", visual.palette.text],
  ];

  return (
    <section className="rounded-xl border border-fuchsia-500/20 bg-ink-900/60">
      <header className="flex items-center gap-2 border-b border-ink-800 px-4 py-3">
        <span className="size-2 rounded-full bg-fuchsia-400" />
        <h2 className="text-sm font-medium text-ink-200">产品视觉方案</h2>
        <span className="text-[11px] text-ink-400">Luna · 产品设计师</span>
      </header>

      <div className="space-y-5 px-4 py-4">
        <div>
          <p className="text-base font-medium leading-relaxed text-fuchsia-200">
            {visual.concept}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">{visual.tone}</p>
        </div>

        <div className="grid gap-3 md:grid-cols-[1.2fr_1fr]">
          <div className="rounded-lg border border-ink-800 bg-ink-850/50 p-3">
            <h3 className="text-[11px] uppercase tracking-wide text-ink-500">页面构图</h3>
            <p className="mt-2 text-xs leading-relaxed text-ink-200">{visual.layout.shell}</p>
            <ol className="mt-2 space-y-1">
              {visual.layout.hierarchy.map((item, index) => (
                <li key={item} className="flex gap-2 text-[11px] leading-relaxed text-ink-400">
                  <span className="font-mono text-fuchsia-400/80">0{index + 1}</span>
                  {item}
                </li>
              ))}
            </ol>
            <p className="mt-2 border-t border-ink-800 pt-2 text-[11px] leading-relaxed text-ink-500">
              响应式：{visual.layout.responsive}
            </p>
          </div>

          <div className="rounded-lg border border-ink-800 bg-ink-850/50 p-3">
            <h3 className="text-[11px] uppercase tracking-wide text-ink-500">色彩系统</h3>
            <dl className="mt-2 space-y-1.5">
              {palette.map(([label, value]) => (
                <div key={label} className="grid grid-cols-[52px_1fr] gap-2 text-[11px]">
                  <dt className="text-ink-500">{label}</dt>
                  <dd className="font-mono leading-relaxed text-ink-300">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-ink-500">用户体验</h3>
          <div className="mt-2 grid gap-3 md:grid-cols-[1fr_1fr]">
            <ol className="space-y-1.5 border-l border-fuchsia-500/30 pl-3">
              {visual.experience.primaryJourney.map((step, index) => (
                <li key={step} className="text-[11px] leading-relaxed text-ink-300">
                  <span className="mr-2 font-mono text-fuchsia-400/70">{index + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
            <div className="space-y-2 text-[11px] leading-relaxed">
              <p className="text-ink-300">{visual.experience.navigation}</p>
              <div className="flex flex-wrap gap-1">
                {visual.experience.keyStates.map((state) => (
                  <span key={state} className="rounded bg-ink-800 px-1.5 py-0.5 text-ink-400">
                    {state}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-ink-500">标志性设计元素</h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {visual.signatureElements.map((item) => (
              <span
                key={item}
                className="rounded-md border border-fuchsia-500/20 bg-fuchsia-500/5 px-2 py-1 text-[11px] text-fuchsia-200/90"
              >
                {item}
              </span>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-ink-500">组件处理</h3>
          <div className="mt-2 divide-y divide-ink-800 rounded-lg border border-ink-800 bg-ink-850/40">
            {visual.componentTreatments.map((item) => (
              <div key={item.component} className="grid gap-1 px-3 py-2 sm:grid-cols-[120px_1fr]">
                <span className="text-[11px] font-medium text-ink-200">{item.component}</span>
                <span className="text-[11px] leading-relaxed text-ink-400">{item.treatment}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-ink-500">明确避免</h3>
          <p className="mt-1.5 text-[11px] leading-relaxed text-rose-200/70">
            {visual.avoid.join(" · ")}
          </p>
        </div>
      </div>
    </section>
  );
}
