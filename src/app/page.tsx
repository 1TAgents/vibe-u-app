"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ProjectList, type RunSummary } from "@/components/ProjectList";

const EXAMPLES = [
  "做一个习惯打卡应用,能新建习惯、每天打卡、看连续天数",
  "做一个极简记账本,能记录收支、按分类统计本月结余",
  "做一个读书笔记应用,能添加书籍、写摘录、按书查看",
  "做一个团队看板,任务能在待办/进行中/已完成之间流转",
];

export default function Home() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [reviewRequirements, setReviewRequirements] = useState(false);

  useEffect(() => {
    void fetch("/api/models")
      .then((r) => r.json())
      .then((d: { default: string; options: string[] }) => {
        setModels(d.options);
        setModel(d.default);
      })
      .catch(() => {});
    void fetch("/api/run")
      .then((r) => r.json())
      .then((d: { runs: RunSummary[] }) => setRuns(d.runs ?? []))
      .catch(() => {});
  }, []);

  const go = (p: string) => {
    const q = p.trim();
    if (!q) return;
    const review = reviewRequirements ? "&review=1" : "";
    router.push(`/workspace?prompt=${encodeURIComponent(q)}&model=${encodeURIComponent(model)}${review}`);
  };

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[34rem] bg-[radial-gradient(circle_at_24%_0%,rgba(16,185,129,0.08),transparent_38%),radial-gradient(circle_at_78%_8%,rgba(59,130,246,0.06),transparent_34%)]" />
      <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col px-5 pb-8 pt-10 sm:px-8 sm:pt-16">
      <header className="max-w-3xl">
        <div className="flex items-center gap-3">
          <div className="text-lg font-semibold tracking-[-0.03em] text-ink-100">
            Vibe<span className="text-emerald-400">U</span>
          </div>
          <span className="h-3.5 w-px bg-ink-700" aria-hidden="true" />
          <span className="text-[11px] tracking-[0.16em] text-ink-500">AI 产品团队</span>
        </div>
        <h1 className="mt-10 max-w-3xl text-balance text-[clamp(2.5rem,6vw,4.5rem)] font-semibold leading-[1.08] tracking-[-0.055em] text-ink-100">
          从一句需求，到一个能用的产品。
        </h1>
        <p className="mt-5 max-w-2xl text-[15px] leading-7 text-ink-400 sm:text-base">
          说清你想解决的问题。产品、设计、工程和测试会接力完成，过程可见，结果可用。
        </p>
      </header>

      <section className="mt-10 max-w-4xl">
        <div className="rounded-2xl border border-ink-700/80 bg-ink-900/75 p-2 shadow-[0_24px_80px_rgba(0,0,0,0.24)] transition-colors focus-within:border-emerald-500/45">
          <label htmlFor="product-brief" className="block px-3 pt-2 text-[11px] font-medium tracking-wide text-ink-400">
            你想做什么？
          </label>
          <textarea
            id="product-brief"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go(prompt);
            }}
            rows={3}
            placeholder="描述使用者、核心问题和最重要的功能…"
            className="w-full resize-none bg-transparent px-3 py-3 text-base leading-7 text-ink-100 outline-none placeholder:text-ink-600"
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-ink-800 px-2 pt-2">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-label="模型"
              className="rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-2 font-mono text-[11px] text-ink-400 outline-none focus:border-ink-600"
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <span className="hidden text-[11px] text-ink-600 sm:inline">⌘/Ctrl + Enter</span>
            <button
              type="button"
              onClick={() => setReviewRequirements((value) => !value)}
              aria-pressed={reviewRequirements}
              title="开启后，产品需求文档完成时会暂停，等待你修改或批准"
              className={`rounded-lg border px-2.5 py-2 text-[11px] transition-colors ${
                reviewRequirements
                  ? "border-violet-500/50 bg-violet-500/15 text-violet-200"
                  : "border-ink-700 text-ink-500 hover:text-ink-300"
              }`}
            >
              审核需求 · {reviewRequirements ? "开" : "关"}
            </button>
            <button
              onClick={() => go(prompt)}
              disabled={!prompt.trim()}
              className="ml-auto rounded-lg bg-emerald-400 px-5 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-ink-800 disabled:text-ink-600"
            >
              开始
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[11px] text-ink-600">可以试试</span>
          {EXAMPLES.map((e) => (
            <button
              key={e}
              onClick={() => setPrompt(e)}
              className="rounded-full border border-ink-800 bg-ink-900/30 px-3 py-1.5 text-[12px] text-ink-500 transition-colors hover:border-ink-600 hover:text-ink-200"
            >
              {e.split(",")[0]}
            </button>
          ))}
        </div>
      </section>

      <ProjectList runs={runs} />

      <footer className="mt-auto pt-16 text-[11px] text-ink-700">VibeU</footer>
      </div>
    </div>
  );
}
