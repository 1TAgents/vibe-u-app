import assert from "node:assert/strict";
import { buildApp } from "../src/lib/builder";
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
            return <main><Check aria-hidden="true" /><h1>builder smoke test</h1></main>;
          }
        `,
      },
    ]),
  );

  assert.equal(built.ok, true, built.ok ? undefined : JSON.stringify(built.errors));
  if (built.ok) {
    assert.match(built.js, /builder smoke test/);
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
