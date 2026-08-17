import type { GeneratedFile } from "@/lib/events";

/** 代码是产物，不应借用预览 iframe 冒充代码视图。 */
export function CodeView({ files }: { files: GeneratedFile[] }) {
  return (
    <div className="mx-auto max-w-5xl space-y-3 p-4">
      {files.map((file) => (
        <section key={file.path} className="overflow-hidden rounded-lg border border-ink-800 bg-ink-900/60">
          <header className="border-b border-ink-800 px-3 py-2 font-mono text-xs text-ink-300">
            {file.path}
          </header>
          <pre className="overflow-auto p-3 text-[11px] leading-relaxed text-ink-300">
            <code>{file.content}</code>
          </pre>
        </section>
      ))}
    </div>
  );
}
