import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { appHtml } from "../src/lib/builder";
import { runTests } from "../src/lib/testrunner";

const source = `
  import { createRoot } from "react-dom/client";
  function App() {
    return <main>
      <p>专注 · 待开始</p>
      <section aria-label="当前阶段"><span>休息 • 进行中</span></section>
      <p>月供 9,844.97 元</p>
    </main>;
  }
  createRoot(document.getElementById("root")).render(<App />);
`;
async function main() {
const result = await esbuild.build({
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
  title: "分隔符",
  js: result.outputFiles?.[0]?.text ?? "",
  css: "",
  runId: "cosmetic-separator",
  apiBase: "",
  embed: true,
});
const report = await runTests(html, "cosmetic-separator", [{
  name: "装饰性中点不影响业务文案断言",
  steps: [
    { action: "expectText", text: "专注 待开始" },
    { action: "expectTextWithin", target: "当前阶段", text: "休息 进行中" },
    { action: "expectText", text: "月供 9844.97 元" },
  ],
}]);

assert.equal(report.failed, 0, JSON.stringify(report.failures));
console.log("Cosmetic separator · ✓ 中点分隔符不制造文案假失败");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
