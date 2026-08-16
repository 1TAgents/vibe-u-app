"use client";

import type { Design } from "@/lib/roles";

export function DesignCard({ design }: { design: Design }) {
  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900/60">
      <header className="flex items-center gap-2 border-b border-ink-800 px-4 py-3">
        <span className="size-2 rounded-full bg-sky-400" />
        <h2 className="text-sm font-medium text-ink-200">技术设计</h2>
        <span className="text-[11px] text-ink-400">Bob · 系统架构师</span>
      </header>

      <div className="space-y-5 px-4 py-4">
        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-ink-500">
            数据模型 · 服务端持久化
          </h3>
          <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
            {design.dataModel.map((m) => (
              <div key={m.name} className="rounded-lg border border-ink-800 bg-ink-850/50">
                <div className="border-b border-ink-800 px-3 py-2">
                  <span className="font-mono text-[13px] text-sky-300">{m.name}</span>
                  <p className="mt-0.5 text-[11px] text-ink-400">{m.description}</p>
                </div>
                <ul className="divide-y divide-ink-800/70">
                  {/* 平台自动补的系统字段,显式画出来,避免看起来像"漏了主键" */}
                  <li className="flex items-baseline gap-2 px-3 py-1.5">
                    <span className="font-mono text-[11px] text-ink-500">id</span>
                    <span className="font-mono text-[10px] text-ink-600">string</span>
                    <span className="ml-auto text-[10px] text-ink-600">平台注入</span>
                  </li>
                  <li className="flex items-baseline gap-2 px-3 py-1.5">
                    <span className="font-mono text-[11px] text-ink-500">createdAt</span>
                    <span className="font-mono text-[10px] text-ink-600">number</span>
                    <span className="ml-auto text-[10px] text-ink-600">平台注入</span>
                  </li>
                  {m.fields.map((f) => (
                    <li key={f.name} className="flex items-baseline gap-2 px-3 py-1.5">
                      <span className="font-mono text-[11px] text-ink-200">{f.name}</span>
                      <span className="font-mono text-[10px] text-ink-500">{f.type}</span>
                      {f.required && (
                        <span className="text-[10px] text-amber-400/80">必填</span>
                      )}
                      {f.description && (
                        <span className="ml-auto truncate text-[10px] text-ink-500">
                          {f.description}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-ink-500">页面结构</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {design.pages.map((p) => (
              <div
                key={p.name}
                className="min-w-[180px] flex-1 rounded-lg border border-ink-800 bg-ink-850/50 px-3 py-2"
              >
                <span className="text-[13px] text-ink-200">{p.name}</span>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-400">
                  {p.description}
                </p>
                {p.components.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {p.components.map((c) => (
                      <span
                        key={c}
                        className="rounded bg-ink-800 px-1.5 py-px font-mono text-[10px] text-ink-400"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {design.notes && (
          <div>
            <h3 className="text-[11px] uppercase tracking-wide text-ink-500">设计取舍</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-300">{design.notes}</p>
          </div>
        )}
      </div>
    </section>
  );
}
