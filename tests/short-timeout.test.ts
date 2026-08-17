import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { appHtml } from "../src/lib/builder";
import { runTests } from "../src/lib/testrunner";

const source = `
  import { createRoot } from "react-dom/client";
  import { useState } from "react";
  function App() {
    const [result, setResult] = useState("");
    return <main>
      <button onClick={() => setTimeout(() => setResult("计算完成"), 200)}>计算</button>
      <p>{result}</p>
    </main>;
  }
  createRoot(document.getElementById("root")).render(<App />);
`;
async function main() {
const built = await esbuild.build({
  stdin: { contents: source, loader: "jsx", resolveDir: process.cwd() },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "silent",
});
const html = appHtml({
  title: "短暂反馈",
  js: built.outputFiles?.[0]?.text ?? "",
  css: "",
  runId: "short-timeout",
  apiBase: "",
  embed: true,
});
const report = await runTests(html, "short-timeout", [{
  name: "短暂 UI 反馈不被业务假时钟冻结",
  steps: [
    { action: "click", target: "计算" },
    { action: "expectText", text: "计算完成" },
  ],
}]);

assert.equal(report.failed, 0, JSON.stringify(report.failures));
console.log("Short timeout · ✓ 短暂 UI 反馈继续走真实时间");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
