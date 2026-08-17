/**
 * 对既有本地 run 的最新源码与最新 Tess 用例做一次确定性重放。
 *
 * 用法：DATABASE_URL= npm run replay-qa -- <runId>
 * 不调用模型、不新增派单，适合把生成应用缺陷与测试执行器缺陷分开定位。
 */

import { appHtml, buildApp } from "../src/lib/builder";
import { foldEvents } from "../src/lib/fold";
import { withRuntimeFiles } from "../src/lib/runtime-files";
import { getStore } from "../src/lib/store";
import { runTests } from "../src/lib/testrunner";

async function main() {
  const runId = process.argv[2]?.trim();
  if (!runId) throw new Error("请提供 runId");

  const events = await getStore().readEvents(runId);
  if (events.length === 0) throw new Error(`找不到 run：${runId}`);
  const state = foldEvents(events);
  if (state.files.length === 0) throw new Error("run 尚无源码");
  if (!state.testCases?.length) throw new Error("run 尚无验收用例");

  const built = await buildApp(withRuntimeFiles(state.files));
  if (!built.ok) throw new Error(`构建失败：${built.errors.map((e) => e.message).join("；")}`);
  const html = appHtml({
    title: state.prd?.title ?? "应用",
    js: built.js,
    css: built.css,
    runId,
    apiBase: "",
    embed: true,
  });
  const report = await runTests(html, `${runId}__replay`, state.testCases);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.failed === 0 ? 0 : 1;
}

void main();
