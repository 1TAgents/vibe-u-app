"use client";

/**
 * 群聊 —— 一支 AI 团队在群里讨论并推进这个产品,你也在群里。
 *
 * 设计主张:**过程本身就是一场对话**。
 * 之前把它拆成「轨迹面板」+「输入框」两块,是把一件事建模成了两件事 ——
 * 用户的指令和 agent 的工作本来就该在同一条时间线上。
 *
 * 但群聊有个天然缺陷:信息一多就成了刷屏,产物淹没在噪音里。
 * 所以这里每条只说**一句既成事实**(「写完了,9 个文件」),
 * 真正的材料 —— 思考链、我们发出去的 prompt、模型的原始输出 ——
 * 收在每条消息背后,点开才展开。
 *
 * 一句话:群里说结论,细节留档可查,活儿在右边的产物区。
 */

import { useEffect, useRef, useState } from "react";
import { cn, fmtMs, fmtTokens, fmtUsd } from "@/lib/cn";
import { toFeed, type FeedItem } from "@/lib/chatfeed";
import type { RunState } from "@/lib/fold";
import type { QueuedChange } from "@/lib/store";
import type { Phase } from "@/lib/useRun";

const ACCENT: Record<string, { text: string; bg: string; ring: string }> = {
  violet: { text: "text-violet-300", bg: "bg-violet-500/15", ring: "ring-violet-400/30" },
  sky: { text: "text-sky-300", bg: "bg-sky-500/15", ring: "ring-sky-400/30" },
  emerald: { text: "text-emerald-300", bg: "bg-emerald-500/15", ring: "ring-emerald-400/30" },
  amber: { text: "text-amber-300", bg: "bg-amber-500/15", ring: "ring-amber-400/30" },
  rose: { text: "text-rose-300", bg: "bg-rose-500/15", ring: "ring-rose-400/30" },
  fuchsia: { text: "text-fuchsia-300", bg: "bg-fuchsia-500/15", ring: "ring-fuchsia-400/30" },
};
const FALLBACK = ACCENT.sky;

export function GroupChat({
  state,
  phase,
  version,
  queuedChanges = [],
  onSend,
  onDeleteQueued,
  /** 回放时只看不发 —— 但渲染逻辑与实时完全共用同一份 */
  readOnly = false,
}: {
  state: RunState;
  phase: Phase;
  version: number;
  queuedChanges?: QueuedChange[];
  onSend?: (text: string) => void;
  onDeleteQueued?: (id: string) => void;
  readOnly?: boolean;
}) {
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const feed = toFeed(state);

  const refining = phase === "awaiting_approval";
  // 审核阶段直接在右侧 PRD 卡接管修改并批准；群聊输入只处理已有产品的后续需求。
  const busy = phase === "generating" || phase === "fixing" || phase === "verifying";
  const hasActiveRun = state.prompt !== "" || state.timeline.length > 0;
  const ready =
    phase !== "awaiting_approval" &&
    phase !== "idle" &&
    (state.files.length > 0 || (busy && hasActiveRun));

  // 只在用户没有主动往上翻时才自动贴底 —— 否则他正看历史就被拽走了
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [version, feed.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const send = () => {
    const t = text.trim();
    if (!t || !ready) return;
    onSend?.(t);
    setText("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-800 px-3 py-2">
        <h2 className="text-[11px] uppercase tracking-wide text-ink-500">
          团队群聊
        </h2>
        {readOnly && (
          <span className="rounded bg-ink-800 px-1.5 py-px text-[10px] text-ink-400">
            回放
          </span>
        )}
        <span className="text-[10px] text-ink-600">点开任意发言可审计</span>
        {state.chat.length > 0 && (
          <span className="ml-auto rounded bg-ink-800 px-1.5 py-px font-mono text-[10px] text-ink-400">
            第 {state.chat.length} 轮修改
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 space-y-2 overflow-auto p-2.5"
      >
        {feed.length === 0 && (
          <p className="py-10 text-center text-sm text-ink-500">等待团队开工…</p>
        )}
        {feed.map((it) => (
          <Message key={it.id} item={it} />
        ))}
        {busy && (
          <p className="px-1 py-1 text-[11px] text-ink-500">
            <span className="mr-1.5 inline-block size-1.5 rounded-full bg-sky-400 pulse-dot align-middle" />
            团队正在推进…
          </p>
        )}
      </div>

      {!readOnly && (
        <div className="shrink-0 border-t border-ink-800 bg-ink-950/95">
          {queuedChanges.length > 0 && (
            <section aria-label="待处理任务" className="border-b border-ink-800/80 px-3 py-2">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[10px] font-medium text-ink-300">待处理</span>
                <span className="rounded-full bg-violet-500/15 px-1.5 py-px font-mono text-[9px] text-violet-300">
                  {queuedChanges.length}
                </span>
                <span className="ml-auto text-[9px] text-ink-600">当前轮结束后按顺序执行</span>
              </div>
              <div className="max-h-28 space-y-1 overflow-auto pr-0.5">
                {queuedChanges.map((item, index) => {
                  const canDelete = item.status === "pending";
                  return (
                    <div
                      key={item.id}
                      className="group flex min-h-8 items-center gap-2 rounded-md border border-ink-700/80 bg-ink-900/80 px-2 py-1.5"
                    >
                      <QueueIcon />
                      <span className="min-w-0 flex-1 truncate text-[11px] text-ink-200" title={item.text}>
                        {item.text}
                      </span>
                      <span className="shrink-0 text-[9px] text-ink-600">
                        {canDelete ? `第 ${index + 1} 条` : "处理中"}
                      </span>
                      <button
                        type="button"
                        onClick={() => canDelete && onDeleteQueued?.(item.id)}
                        disabled={!canDelete}
                        aria-label={`删除排队任务：${item.text}`}
                        title={canDelete ? "删除这条排队任务" : "任务已开始处理，不能删除"}
                        className="flex size-6 shrink-0 items-center justify-center rounded text-ink-500 transition-colors hover:bg-rose-500/10 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <div className="p-3">
            <div
              className={cn(
                "rounded-lg border bg-ink-900/60 transition-colors",
                ready ? "border-ink-700 focus-within:border-violet-400/50" : "border-ink-800",
              )}
            >
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                disabled={!ready}
                rows={2}
                placeholder={
                  refining
                    ? "请在右侧 PRD 卡中修改或批准需求"
                    : busy
                      ? "继续提要求，将排到当前轮之后…"
                      : ready
                        ? "描述你想调整的内容…"
                        : "等应用做好就可以在这里提要求"
                }
                className="w-full resize-none bg-transparent px-2.5 py-2 text-[12px] leading-relaxed text-ink-100 outline-none placeholder:text-ink-600 disabled:cursor-not-allowed"
              />
              <div className="flex items-center gap-2 px-2 pb-1.5">
                <span className="text-[10px] text-ink-600">Enter 发送</span>
                <button
                  onClick={send}
                  disabled={!ready || !text.trim()}
                  className="ml-auto rounded bg-violet-500/90 px-2.5 py-1 text-[11px] font-medium text-ink-950 transition-colors hover:bg-violet-400 disabled:cursor-not-allowed disabled:bg-ink-800 disabled:text-ink-600"
                >
                  {busy || queuedChanges.length > 0 ? "排队" : "发送"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function QueueIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-3.5 shrink-0 text-violet-300/80">
      <path d="M4 4v5a3 3 0 0 0 3 3h7m-3-3 3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-3.5">
      <path d="M4.5 6h11M8 3.5h4M6 6l.7 10h6.6L14 6M8.25 8.5v5M11.75 8.5v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Message({ item }: { item: FeedItem }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"reasoning" | "prompt" | "raw">("reasoning");

  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-br-sm bg-violet-500/20 px-2.5 py-1.5 text-[12px] leading-relaxed text-ink-100">
          {item.text}
        </div>
      </div>
    );
  }

  if (item.kind === "system") {
    return (
      <div
        className={cn(
          "rounded-lg border px-2.5 py-1.5 text-[11px] leading-relaxed",
          item.tone === "error"
            ? "border-rose-500/25 bg-rose-500/5 text-rose-200/90"
            : item.tone === "warn"
              ? "border-amber-500/30 bg-amber-500/5 text-amber-200/90"
              : item.tone === "ok"
                ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-200/80"
                : "border-ink-800 bg-ink-900/50 text-ink-400",
        )}
      >
        {item.text}
        <Tags tags={item.tags} />
      </div>
    );
  }

  const c = ACCENT[item.accent ?? ""] ?? FALLBACK;
  const running = item.status === "running";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-ink-900/60",
        running ? cn("border-ink-600 ring-1", c.ring) : "border-ink-800",
        item.status === "failed" && "border-rose-500/40",
      )}
    >
      <button
        onClick={() => item.detail && setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-ink-850/50"
      >
        <span
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium",
            c.bg,
            c.text,
          )}
        >
          {item.name?.[0] ?? "?"}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className={cn("text-[12px] font-medium", c.text)}>{item.name}</span>
            <span className="text-[10px] text-ink-500">{item.title}</span>
            {running && (
              <span className="size-1.5 rounded-full bg-current pulse-dot" />
            )}
          </div>

          <p
            className={cn(
              "mt-0.5 text-[12px] leading-relaxed",
              item.tone === "error" ? "text-rose-200/90" : "text-ink-200",
            )}
          >
            {item.text}
          </p>

          <Tags tags={item.tags} />

          {item.detail && !running && item.detail.tokens > 0 && (
            <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-ink-600">
              <span>{fmtMs(item.detail.durationMs)}</span>
              <span>{fmtTokens(item.detail.tokens)} tok</span>
              <span>{fmtUsd(item.detail.costUsd)}</span>
              <span className="ml-auto">{open ? "收起" : "点开审计"}</span>
            </div>
          )}
        </div>
      </button>

      {open && item.detail && (
        <div className="border-t border-ink-800">
          <div className="flex gap-1 border-b border-ink-800 px-2 py-1.5">
            <Tab active={tab === "reasoning"} onClick={() => setTab("reasoning")}>
              思考链
            </Tab>
            <Tab active={tab === "prompt"} onClick={() => setTab("prompt")}>
              发出的 prompt
            </Tab>
            <Tab active={tab === "raw"} onClick={() => setTab("raw")}>
              原始输出
            </Tab>
            <span className="ml-auto self-center font-mono text-[10px] text-ink-600">
              {item.detail.model}
            </span>
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[10px] leading-relaxed text-ink-300">
            {tab === "reasoning"
              ? item.detail.reasoning || "该模型未返回思考链"
              : tab === "prompt"
                ? item.detail.prompt || "(尚未完成)"
                : item.detail.raw || "(尚无输出)"}
          </pre>
        </div>
      )}
    </div>
  );
}

function Tags({ tags }: { tags?: string[] }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {tags.map((t) => (
        <span
          key={t}
          className="rounded bg-ink-850 px-1.5 py-px font-mono text-[10px] text-ink-400"
        >
          {t}
        </span>
      ))}
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
        "rounded px-2 py-1 text-[10px] transition-colors",
        active ? "bg-ink-800 text-ink-200" : "text-ink-500 hover:text-ink-300",
      )}
    >
      {children}
    </button>
  );
}
