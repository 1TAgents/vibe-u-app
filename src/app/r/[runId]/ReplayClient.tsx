"use client";

/**
 * 回放页。
 *
 * 这里没有一行"回放专用"的渲染逻辑 —— 它把事件流 fold 到第 N 条,然后交给
 * 和实时工作区完全相同的组件去画。实时和回放是同一份代码的两次调用,
 * 所以不存在"实时看到的"和"分享出去别人看到的"不一致这种问题。
 *
 * 而且它回放的是**完整的真相**:包括产物被 schema 打回的那次、校验失败的那次、
 * 以及工程师是怎么改好的。只展示成功路径的 demo 是在演戏。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CostBar } from "@/components/CostBar";
import { DesignCard } from "@/components/DesignCard";
import { PrdCard } from "@/components/PrdCard";
import { Preview } from "@/components/Preview";
import { TestReport } from "@/components/TestReport";
import { GroupChat } from "@/components/GroupChat";
import { VerifyPanel } from "@/components/VerifyPanel";
import { cn, fmtMs } from "@/lib/cn";
import type { Envelope, RunEvent } from "@/lib/events";
import { foldUpTo } from "@/lib/fold";
import type { Phase } from "@/lib/useRun";

type View = "design" | "code" | "preview" | "tests";

const SPEEDS = [1, 4, 16, 64];

export function ReplayClient({ runId }: { runId: string }) {
  const [events, setEvents] = useState<Envelope<RunEvent>[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(16);
  const [view, setView] = useState<View>("design");
  const [notFound, setNotFound] = useState(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    void fetch(`/api/run/${runId}/events`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("404"))))
      .then((d: { events: Envelope<RunEvent>[] }) => {
        setEvents(d.events);
        setCursor(d.events.length); // 默认停在终局,想看过程再往回拖
      })
      .catch(() => setNotFound(true));
  }, [runId]);

  /**
   * 按事件的真实时间戳推进,而不是等间隔播放 ——
   * 只有这样才能还原"哪个角色慢、慢在哪一段"的真实节奏感。
   */
  const atEnd = !!events && cursor >= events.length;

  useEffect(() => {
    if (!playing || atEnd || !events || events.length === 0) return;
    const t0 = events[0].ts;
    const startWall = performance.now();
    const startVirtual = cursor > 0 ? events[cursor - 1].ts - t0 : 0;

    const tick = () => {
      const elapsed = (performance.now() - startWall) * speed;
      const target = startVirtual + elapsed;
      let i = cursor;
      while (i < events.length && events[i].ts - t0 <= target) i++;
      if (i !== cursor) setCursor(i);
      if (i >= events.length) {
        setPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, atEnd, cursor, events, speed]);

  const state = useMemo(
    () => (events ? foldUpTo(events, cursor) : null),
    [events, cursor],
  );

  const phase: Phase = useMemo(() => {
    if (!state) return "idle";
    if (state.aborted || state.finished === "failed") return "failed";
    if (state.finished === "succeeded") return "succeeded";
    if (state.awaiting === "approval") return "awaiting_approval";
    return "generating";
  }, [state]);

  const noop = useCallback(() => {}, []);

  if (notFound) {
    return (
      <Empty>
        找不到这次生成。
        <Link href="/" className="ml-2 text-emerald-400 underline underline-offset-2">
          回首页
        </Link>
      </Empty>
    );
  }
  if (!events || !state) return <Empty>正在载入事件流…</Empty>;
  if (events.length === 0) return <Empty>这次生成没有留下任何事件。</Empty>;

  const elapsed = cursor > 0 ? events[Math.min(cursor, events.length) - 1].ts - events[0].ts : 0;
  const total = events[events.length - 1].ts - events[0].ts;

  return (
    <div className="flex h-screen flex-col bg-ink-950">
      <header className="shrink-0 border-b border-ink-800 bg-ink-900/50 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link href="/" className="shrink-0 text-sm font-medium tracking-tight text-ink-200">
            <span className="text-emerald-400">VibeU</span>
          </Link>
          <span className="rounded bg-ink-800 px-2 py-0.5 text-[11px] text-ink-400">
            回放
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-400">
            {state.prompt}
          </span>
        </div>
        <div className="mt-2">
          <CostBar state={state} phase={phase} />
        </div>
      </header>

      {/* 播放控制条 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900/30 px-4 py-2">
        <button
          onClick={() => {
            if (atEnd) setCursor(0);
            setPlaying((p) => !p);
          }}
          className="w-16 rounded bg-emerald-500/90 px-3 py-1.5 text-[12px] font-medium text-ink-950 hover:bg-emerald-400"
        >
          {playing && !atEnd ? "暂停" : atEnd ? "重播" : "播放"}
        </button>

        <input
          type="range"
          min={0}
          max={events.length}
          value={cursor}
          onChange={(e) => {
            setPlaying(false);
            setCursor(Number(e.target.value));
          }}
          className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-ink-700 accent-emerald-400"
        />

        <span className="w-32 shrink-0 text-right font-mono text-[11px] text-ink-400">
          {fmtMs(elapsed)} / {fmtMs(total)}
        </span>
        <span className="w-24 shrink-0 text-right font-mono text-[11px] text-ink-500">
          {cursor} / {events.length} 事件
        </span>

        <div className="flex shrink-0 gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[11px]",
                speed === s ? "bg-ink-700 text-ink-100" : "text-ink-500 hover:text-ink-300",
              )}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 与工作区共用同一个群聊组件 —— 实时看到的和回放看到的不可能不一致 */}
        <aside className="flex w-[360px] shrink-0 flex-col border-r border-ink-800">
          <GroupChat state={state} phase={phase} version={cursor} readOnly />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <nav className="flex shrink-0 items-center gap-1 border-b border-ink-800 px-3 py-1.5">
            <Tab active={view === "design"} onClick={() => setView("design")}>
              设计
            </Tab>
            <Tab active={view === "code"} onClick={() => setView("code")}>
              代码
            </Tab>
            <Tab active={view === "preview"} onClick={() => setView("preview")}>
              预览
            </Tab>
            <Tab active={view === "tests"} onClick={() => setView("tests")}>
              测试
            </Tab>
            <span className="ml-auto text-[11px] text-ink-600">
              预览是当前帧的代码,可以直接用
            </span>
          </nav>

          <div className="min-h-0 flex-1 overflow-hidden">
            <div className={cn("h-full overflow-auto", view === "tests" ? "block" : "hidden")}>
              <TestReport state={state} />
            </div>

            <div className={cn("h-full overflow-auto", view === "design" ? "block" : "hidden")}>
              <div className="mx-auto max-w-3xl space-y-4 p-4">
                {state.prd ? (
                  <PrdCard
                    prd={state.prd}
                    awaiting={false}
                    decided={state.hitl}
                    onApprove={noop}
                    onReject={noop}
                  />
                ) : (
                  <p className="py-16 text-center text-sm text-ink-500">PRD 还没写出来</p>
                )}
                {state.design && <DesignCard design={state.design} />}
                <VerifyPanel state={state} />
              </div>
            </div>

            <div className={cn("h-full", view === "code" || view === "preview" ? "block" : "hidden")}>
              {state.files.length > 0 ? (
                <Preview runId={runId} revision={0} />
              ) : (
                <p className="flex h-full items-center justify-center text-sm text-ink-500">
                  这一帧还没有代码
                </p>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded px-3 py-1.5 text-[13px] transition-colors",
        active ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:text-ink-200",
      )}
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen items-center justify-center text-sm text-ink-400">
      {children}
    </div>
  );
}
