import assert from "node:assert/strict";
import { buildApp, hasUsableGeneratedCss } from "../src/lib/builder";
import { styleEvidenceIssues } from "../src/lib/delivery";
import { withRuntimeFiles } from "../src/lib/runtime-files";

async function main() {
  const built = await buildApp(
    withRuntimeFiles([
      {
        path: "/App.js",
        content: `
          import React from "react";
          import { Check } from "lucide-react";
          export default function App() {
            return <main className="min-h-screen bg-[#f6f4ef] text-[#1e3a5f]"><Check aria-hidden="true" /><h1 className="text-2xl">builder smoke test</h1></main>;
          }
        `,
      },
    ]),
  );

  assert.equal(built.ok, true, built.ok ? undefined : JSON.stringify(built.errors));
  if (built.ok) {
    assert.match(built.js, /builder smoke test/);
    assert.ok(built.css.length > 1_000, `Tailwind 应产出实际 CSS：${built.css.length} bytes`);
    assert.equal(hasUsableGeneratedCss(built.css), true);
    assert.equal(hasUsableGeneratedCss("  \n"), false, "历史空样式 bundle 必须失效并重建");
    assert.match(built.css, /#f6f4ef/i, "任意值背景色必须进入编译产物");
    assert.deepEqual(styleEvidenceIssues(built.css), [], "有效 Tailwind 产物应具备视觉证据");
    assert.ok(styleEvidenceIssues("").length >= 3, "空 CSS 必须被视觉硬门拒绝");
    assert.ok(built.bytes > 0);
    assert.ok(
      built.bytes < 400_000,
      `单个图标不应把整个 lucide-react 打进产物：${built.bytes} bytes`,
    );
  }

  console.log("Builder · ✓ 可解析并 tree-shake React 与 lucide-react");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
