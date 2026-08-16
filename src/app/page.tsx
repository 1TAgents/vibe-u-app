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
    router.push(
      `/workspace?prompt=${encodeURIComponent(q)}&model=${encodeURIComponent(model)}`,
    );
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-16">
      <header>
        <h1 className="text-3xl font-medium tracking-tight text-ink-100">
          vibe<span className="text-emerald-400">U</span>app
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-300">
          一句话需求，
          <strong className="font-medium text-ink-100">一支 AI 团队把它做成能用的应用</strong>。
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-400">
          区别不在能生成代码，而在每一步都要外部证据才算数 ——
          能不能编译、用例过没过、页面上到底有什么，全部由平台判定，不由模型自述。
        </p>
      </header>

      <section className="mt-10">
        <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-1.5 focus-within:border-emerald-500/40">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go(prompt);
            }}
            rows={3}
            placeholder="描述你想要的应用，比如：做一个习惯打卡应用…"
            className="w-full resize-none bg-transparent px-3 py-2.5 text-[15px] text-ink-100 outline-none placeholder:text-ink-600"
          />
          <div className="flex items-center gap-2 px-2 pb-1">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-label="模型"
              className="rounded border border-ink-700 bg-ink-850 px-2 py-1.5 font-mono text-[11px] text-ink-300 outline-none"
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <span className="text-[11px] text-ink-600">⌘/Ctrl + Enter 开跑</span>
            <button
              onClick={() => go(prompt)}
              disabled={!prompt.trim()}
              className="ml-auto rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-ink-800 disabled:text-ink-600"
            >
              开始
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              onClick={() => setPrompt(e)}
              className="rounded-full border border-ink-800 px-3 py-1.5 text-[12px] text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200"
            >
              {e.split(",")[0]}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-[11px] uppercase tracking-wide text-ink-500">六个人，四道门</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Point title="Piper 派活，不写死流程">
            下一步谁接，由项目经理看着当前状态现场决定。测试挂了归哪一层、
            老板中途改需求该谁接，都是它的判断，不是预设分支。
          </Point>
          <Point title="门由产物触发">
            出现新代码就必然构建、必然审计，不管流程走到哪。
            门是平台独占的，角色和调度器都无权关它。
          </Point>
          <Point title="失败先归因再派人">
            用例挂了不一定是写码的人的问题 —— 可能需求没说清、数据模型撑不住。
            责任放错地方，比修得慢更糟。
          </Point>
          <Point title="卡住了给交代，不报「失败」">
            已经有能跑的东西就交付，附上哪里没过、试过什么。
            老板宁可拿到一个有已知问题的产品。
          </Point>
        </div>
      </section>

      <ProjectList runs={runs} />

      <footer className="mt-auto pt-14 text-[11px] text-ink-600">vibeUapp</footer>
    </div>
  );
}

function Point({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900/40 px-3.5 py-3">
      <h3 className="text-[13px] font-medium text-ink-200">{title}</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-400">{children}</p>
    </div>
  );
}
