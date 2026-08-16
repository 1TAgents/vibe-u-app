"use client";

/**
 * 自愈闭环的可视化。
 *
 * 大多数 agent demo 会把失败藏起来,只展示最后成功的那一版。
 * 这里反过来:每一次校验失败、失败原因、以及工程师改了哪几行,全部摊开。
 * 因为"它失败过并且自己修好了"比"它一次就对了"更能说明系统是可靠的。
 */

import { useState } from "react";
import { cn } from "@/lib/cn";
import type { RunState } from "@/lib/fold";

export function VerifyPanel({ state }: { state: RunState }) {
  if (
    state.verifyHistory.length === 0 &&
    state.fixDiffs.length === 0 &&
    state.qaHistory.length === 0
  )
    return null;

  // 把校验结果与随后的修复按 attempt 编织成一条时间线
  const attempts = new Set<number>([
    ...state.verifyHistory.map((v) => v.attempt),
    ...state.fixDiffs.map((d) => d.attempt),
  ]);

  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900/60">
      <header className="flex items-center gap-2 border-b border-ink-800 px-4 py-3">
        <span className="size-2 rounded-full bg-amber-400" />
        <h2 className="text-sm font-medium text-ink-200">运行时校验与自愈</h2>
        <span className="text-[11px] text-ink-400">
          Vera · 质量工程师 · 在真实浏览器里跑起来再下结论
        </span>
      </header>

      <div className="space-y-2.5 px-4 py-4">
        {state.qaHistory.length > 0 && <QaSection state={state} />}
        {state.escalations.map((e, i) => (
          <EscalationRow key={i} esc={e} />
        ))}
        {[...attempts]
          .sort((a, b) => a - b)
          .map((n) => {
            const verify = state.verifyHistory.find((v) => v.attempt === n);
            const fix = state.fixDiffs.find((d) => d.attempt === n);
            return <AttemptRow key={n} attempt={n} verify={verify} fix={fix} />;
          })}
      </div>
    </section>
  );
}

/**
 * 功能级验收结果。
 *
 * 这是与「能渲染」完全不同量级的一条证据:它走的是真实操作 ——
 * 填内容、点提交、断言结果出现。一个只验证渲染的系统会把
 * 「按钮点了没反应」判成通过。
 */
function QaSection({ state }: { state: RunState }) {
  const last = state.qaHistory[state.qaHistory.length - 1];
  const healed = last.failed === 0 && state.qaHistory.length > 1;
  return (
    <div
      className={cn(
        "rounded-lg border",
        last.failed === 0
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-rose-500/30 bg-rose-500/5",
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            last.failed === 0 ? "bg-emerald-400" : "bg-rose-400",
          )}
        />
        <span className="text-[13px] text-ink-200">功能验收</span>
        <span
          className={cn(
            "text-[11px]",
            last.failed === 0 ? "text-emerald-300" : "text-rose-300",
          )}
        >
          {last.passed}/{last.passed + last.failed} 条用例通过
        </span>
        {healed && (
          <span className="rounded bg-ink-800 px-1.5 py-px text-[10px] text-ink-400">
            自愈 {state.qaHistory.length - 1} 次后通过
          </span>
        )}
        {last.failed > 0 && state.qaHistory.length > 1 && (
          <span className="rounded bg-ink-800 px-1.5 py-px text-[10px] text-ink-400">
            已尝试自愈 {state.qaHistory.length - 1} 次
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-ink-600">
          {(last.durationMs / 1000).toFixed(1)}s
        </span>
      </div>
      <ul className="space-y-1 border-t border-ink-800 px-3 py-2">
        {last.cases.map((c, i) => (
          <li key={i} className="flex items-baseline gap-2 text-[11px]">
            <span className={c.ok ? "text-emerald-400" : "text-rose-400"}>
              {c.ok ? "✓" : "✗"}
            </span>
            <span className="text-ink-300">{c.name}</span>
            {c.reason && (
              <span className="ml-auto max-w-[60%] truncate text-ink-500" title={c.reason}>
                {c.reason}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 责任升级。
 *
 * 现实团队里,同一个问题工程师改两遍还不对,就该把架构师拉进来 ——
 * 反复实现不出来往往不是手滑,而是设计里缺东西。再不行就得回头问需求。
 *
 * 这里的触发条件是**客观事实**(同一条用例修完仍失败),不是让某个模型
 * 去判断该找谁负责 —— 靠模型分配责任,就是又造了一个只会说话的协调者。
 */
function EscalationRow({ esc }: { esc: { to: string; reason: string; cases: string[] } }) {
  const toHuman = esc.to === "human";
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2",
        toHuman ? "border-amber-500/40 bg-amber-500/5" : "border-sky-500/30 bg-sky-500/5",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("text-[13px]", toHuman ? "text-amber-300" : "text-sky-300")}>
          {toHuman ? "⚑ 需要你介入" : "↑ 升级给架构师"}
        </span>
        {esc.cases.length > 0 && (
          <span className="rounded bg-ink-800 px-1.5 py-px text-[10px] text-ink-400">
            {esc.cases.join(" · ")}
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{esc.reason}</p>
    </div>
  );
}

function AttemptRow({
  attempt,
  verify,
  fix,
}: {
  attempt: number;
  verify?: { ok: boolean; issues: { kind: string; message: string; path?: string }[] };
  fix?: { changed: { path: string; before: string; after: string }[] };
}) {
  const [open, setOpen] = useState(false);
  const ok = verify?.ok === true;
  const pending = !verify;

  return (
    <div
      className={cn(
        "rounded-lg border",
        ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-ink-800 bg-ink-850/40",
      )}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            pending ? "bg-ink-600 pulse-dot" : ok ? "bg-emerald-400" : "bg-rose-400",
          )}
        />
        <span className="text-[13px] text-ink-200">第 {attempt} 次运行</span>
        <span
          className={cn(
            "text-[11px]",
            pending ? "text-ink-400" : ok ? "text-emerald-300" : "text-rose-300",
          )}
        >
          {pending
            ? "校验中…"
            : ok
              ? "通过 · 应用真实渲染成功"
              : `发现 ${verify!.issues.length} 个问题`}
        </span>
        {fix && (
          <span className="rounded bg-ink-800 px-1.5 py-px text-[10px] text-ink-400">
            已自动修复 {fix.changed.length} 个文件
          </span>
        )}
        <span className="ml-auto text-ink-600">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-ink-800 px-3 py-2.5">
          {verify && verify.issues.length > 0 && (
            <div>
              <h4 className="text-[11px] uppercase tracking-wide text-ink-500">
                真实运行时报回的问题
              </h4>
              <ul className="mt-1.5 space-y-1.5">
                {verify.issues.map((i, k) => (
                  <li key={k} className="rounded border border-rose-500/20 bg-rose-500/5 px-2.5 py-1.5">
                    <span className="mr-2 rounded bg-rose-500/15 px-1.5 py-px font-mono text-[10px] text-rose-300">
                      {i.kind === "compile"
                        ? "编译"
                        : i.kind === "blank"
                          ? "白屏"
                          : i.kind === "static"
                            ? "静态审计"
                            : "运行时"}
                    </span>
                    {i.path && (
                      <span className="font-mono text-[11px] text-ink-400">{i.path}</span>
                    )}
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-300">
                      {i.message}
                    </pre>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {fix && (
            <div>
              <h4 className="text-[11px] uppercase tracking-wide text-ink-500">
                工程师的修复
              </h4>
              <div className="mt-1.5 space-y-2">
                {fix.changed.map((c) => (
                  <Diff key={c.path} path={c.path} before={c.before} after={c.after} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 行级 diff。够用即可 —— 目的是让人一眼看出"改动是不是合理",不是取代 git。 */
function Diff({ path, before, after }: { path: string; before: string; after: string }) {
  const a = before.split("\n");
  const b = after.split("\n");
  const removed = new Set(a.filter((l) => !b.includes(l)).slice(0, 40));
  const added = b.filter((l) => !a.includes(l)).slice(0, 40);

  return (
    <div className="overflow-hidden rounded border border-ink-800">
      <div className="border-b border-ink-800 bg-ink-850 px-2.5 py-1 font-mono text-[11px] text-ink-300">
        {path}
        {before === "" && (
          <span className="ml-2 rounded bg-emerald-500/15 px-1.5 text-[10px] text-emerald-300">
            新增文件
          </span>
        )}
      </div>
      <pre className="max-h-56 overflow-auto bg-ink-950/60 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
        {[...removed].map((l, i) => (
          <div key={`r${i}`} className="text-rose-300/80">
            - {l}
          </div>
        ))}
        {added.map((l, i) => (
          <div key={`a${i}`} className="text-emerald-300/80">
            + {l}
          </div>
        ))}
        {removed.size === 0 && added.length === 0 && (
          <div className="text-ink-500">(无行级差异)</div>
        )}
      </pre>
    </div>
  );
}
