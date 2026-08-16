"use client";

/**
 * 工作区。
 *
 * 布局主张:左边是**一支团队在群里推进这个产品(你也在群里)**,右边是**产物**,
 * 两者永远同屏。
 *
 * 群聊的常见毛病是刷屏、产物被淹没。这里的解法不是不做群聊,而是控制信息密度:
 * 群里每条只说一句既成事实,思考链、prompt、原始输出这些材料收在消息背后,
 * 点开才展开;真正的活儿留在右侧产物区。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CostBar } from "@/components/CostBar";
import { GroupChat } from "@/components/GroupChat";
import { DesignCard } from "@/components/DesignCard";
import { PrdCard } from "@/components/PrdCard";
import { Preview } from "@/components/Preview";
import { TestReport } from "@/components/TestReport";
import { VerifyPanel } from "@/components/VerifyPanel";
import { VisualDesignCard } from "@/components/VisualDesignCard";
import { cn } from "@/lib/cn";
import { useRun } from "@/lib/useRun";

type View = "design" | "code" | "preview" | "tests";
const CHAT_COLLAPSED_KEY = "vibeu:chat-collapsed";
const CHAT_COLLAPSED_EVENT = "vibeu:chat-collapsed-change";

export function WorkspaceClient() {
  const params = useSearchParams();
  const router = useRouter();
  const run = useRun();
  const { start, load, state, phase, version, runId, approve, reject, sendMessage, abort, error } =
    run;

  const [view, setView] = useState<View>("design");
  const chatCollapsed = useSyncExternalStore(
    subscribeChatCollapsed,
    getChatCollapsed,
    () => false,
  );
  const startedRef = useRef(false);
  const autoSwitchedRef = useRef(false);

  const prompt = params.get("prompt") ?? "";
  const model = params.get("model") ?? undefined;
  const replayId = params.get("run") ?? undefined;
  const reviewRequirements = params.get("review") === "1";

  const toggleChat = useCallback(() => {
    window.localStorage.setItem(CHAT_COLLAPSED_KEY, chatCollapsed ? "0" : "1");
    window.dispatchEvent(new Event(CHAT_COLLAPSED_EVENT));
  }, [chatCollapsed]);

  // 带参进入即自动开跑;带 run 参数则载入历史
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (replayId) void load(replayId);
    else if (prompt) void start(prompt, model, { autoApprove: !reviewRequirements });
  }, [prompt, model, replayId, reviewRequirements, start, load]);

  // 代码一出现就自动切到预览,让人第一时间看到"东西真的跑起来了"
  useEffect(() => {
    if (state.files.length > 0 && !autoSwitchedRef.current) {
      autoSwitchedRef.current = true;
      setView("preview");
    }
  }, [state.files.length, version]);

  const shareUrl = useMemo(
    () => (runId && typeof window !== "undefined" ? `${window.location.origin}/r/${runId}` : ""),
    [runId],
  );
  return (
    <div className="flex h-screen flex-col bg-ink-950">
      <header className="shrink-0 border-b border-ink-800 bg-ink-900/50 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link href="/" className="shrink-0 text-sm font-medium tracking-tight text-ink-200">
            <span className="text-emerald-400">VibeU</span>
          </Link>
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-400" title={state.prompt}>
            {state.prompt || prompt || "—"}
          </span>
          {runId && (
            <CopyLink
              url={shareUrl}
              label="复制回放链接"
              title="复制可审计的团队回放链接"
            />
          )}
        </div>
        <div className="mt-2">
          <CostBar state={state} phase={phase} onAbort={abort} />
        </div>
      </header>

      {error && (
        <div className="shrink-0 border-b border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-200">
          {error}
          <button
            onClick={() => router.push("/")}
            className="ml-3 underline underline-offset-2 hover:text-rose-100"
          >
            重新开始
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 左:一支团队在群里推进这个产品,你也在群里 */}
        <aside
          className={cn(
            "relative flex shrink-0 flex-col border-r border-ink-800 transition-[width] duration-200",
            chatCollapsed ? "w-11" : "w-[360px]",
          )}
        >
          <button
            type="button"
            onClick={toggleChat}
            aria-label={chatCollapsed ? "展开团队群聊" : "收起团队群聊"}
            title={chatCollapsed ? "展开团队群聊" : "收起团队群聊"}
            className={cn(
              "absolute z-10 flex size-7 items-center justify-center rounded-md border border-ink-700 bg-ink-900 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100",
              chatCollapsed ? "left-2 top-2" : "right-2 top-1.5",
            )}
          >
            <SidebarIcon collapsed={chatCollapsed} />
          </button>
          {!chatCollapsed && (
            <GroupChat
              state={state}
              phase={phase}
              version={version}
              onSend={(t) => void sendMessage(t)}
            />
          )}
        </aside>

        {/* 右:产物 */}
        <main className="flex min-w-0 flex-1 flex-col">
          <nav className="flex shrink-0 items-center gap-1 border-b border-ink-800 px-3 py-1.5">
            <ViewTab active={view === "design"} onClick={() => setView("design")}>
              设计
            </ViewTab>
            <ViewTab
              active={view === "code"}
              onClick={() => setView("code")}
              badge={state.files.length || undefined}
            >
              代码
            </ViewTab>
            <ViewTab
              active={view === "preview"}
              onClick={() => setView("preview")}
              dot={phase === "verifying"}
            >
              预览
            </ViewTab>
            <ViewTab
              active={view === "tests"}
              onClick={() => setView("tests")}
              badge={state.testCases?.length || undefined}
            >
              测试
            </ViewTab>
            {phase === "succeeded" && runId && (
              <span className="ml-auto rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] text-emerald-300">
                完整流程已通过
              </span>
            )}
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
                    awaiting={phase === "awaiting_approval"}
                    decided={state.hitl}
                    onApprove={(p) => void approve(p)}
                    onReject={() => void reject()}
                  />
                ) : (
                  <Placeholder text="Ida 正在写 PRD…" />
                )}
                {state.visual && <VisualDesignCard visual={state.visual} />}
                {state.design && <DesignCard design={state.design} />}
                <VerifyPanel state={state} />
              </div>
            </div>

            <div className={cn("h-full", view === "code" || view === "preview" ? "block" : "hidden")}>
              {runId && state.files.length > 0 ? (
                <Preview runId={runId} version={version} />
              ) : (
                  <Placeholder text="Luna 正在定视觉方案，随后由 Cody 实现" />
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  children,
  badge,
  dot,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: number;
  dot?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded px-3 py-1.5 text-[13px] transition-colors",
        active ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:text-ink-200",
      )}
    >
      {children}
      {badge !== undefined && (
        <span className="rounded bg-ink-700 px-1.5 font-mono text-[10px] text-ink-300">
          {badge}
        </span>
      )}
      {dot && <span className="size-1.5 rounded-full bg-amber-400 pulse-dot" />}
    </button>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-ink-500">{text}</p>
    </div>
  );
}

function SidebarIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="size-4" aria-hidden="true">
      <rect x="2.5" y="3" width="15" height="14" rx="2.5" stroke="currentColor" />
      <path d="M7 3v14" stroke="currentColor" />
      <path
        d={collapsed ? "m11 7 3 3-3 3" : "m14 7-3 3 3 3"}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getChatCollapsed() {
  return window.localStorage.getItem(CHAT_COLLAPSED_KEY) === "1";
}

function subscribeChatCollapsed(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CHAT_COLLAPSED_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHAT_COLLAPSED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHAT_COLLAPSED_EVENT, onChange);
  };
}

function CopyLink({ url, label, title }: { url: string; label: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className="shrink-0 rounded border border-ink-700 px-2.5 py-1 text-[11px] text-ink-300 transition-colors hover:border-emerald-500/50 hover:text-emerald-300"
      title={title}
    >
      {copied ? "已复制" : label}
    </button>
  );
}
