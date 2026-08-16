/** QA 数据隔离回归测试。 */

import assert from "node:assert/strict";
import { handleAppData } from "../src/lib/appdata";
import { runTests, type TestCase } from "../src/lib/testrunner";

const realRunId = `qa-isolation-real-${Date.now()}`;
const html = `<!doctype html>
<html><head><style>} jsdom-unsupported-css {</style></head><body>
  <div id="root">
    <button id="add">新建</button>
    <span id="count">0 / 0 已完成</span>
    <ul id="list"></ul>
  </div>
  <script>
    const add = document.getElementById("add");
    const count = document.getElementById("count");
    const list = document.getElementById("list");
    async function refresh() {
      const rows = await fetch("/api/appdata/${realRunId}/todos").then((r) => r.json());
      count.textContent = "0 / " + rows.length + " 已完成";
      list.textContent = "";
      for (const row of rows) {
        const item = document.createElement("li");
        item.append(row.title);
        const remove = document.createElement("button");
        remove.textContent = "删除";
        remove.setAttribute("aria-label", "删除任务");
        remove.addEventListener("click", async () => {
          await fetch("/api/appdata/${realRunId}/todos", {
            method: "DELETE",
            body: JSON.stringify({ id: row.id })
          });
          await refresh();
        });
        item.append(remove);
        list.append(item);
      }
    }
    add.addEventListener("click", async () => {
      await fetch("/api/appdata/${realRunId}/todos", {
        method: "POST",
        body: JSON.stringify({ title: "待删除任务", completed: false })
      });
      await refresh();
    });
    void refresh();
  </script>
</body></html>`;

const cases: TestCase[] = [
  {
    name: "第一条用例从空数据开始",
    steps: [
      { action: "click", target: "新建" },
      { action: "expectText", text: "0 / 1 已完成" },
    ],
  },
  {
    name: "第二条用例也从空数据开始",
    steps: [
      { action: "click", target: "新建" },
      { action: "expectText", text: "0 / 1 已完成" },
    ],
  },
  {
    name: "优先点击 aria 标签匹配的删除按钮",
    steps: [
      { action: "click", target: "新建" },
      { action: "expectText", text: "待删除任务" },
      { action: "click", target: "删除任务" },
      { action: "expectNoText", text: "待删除任务" },
    ],
  },
];

async function main() {
  console.log("QA runner · 数据隔离");
  const report = await runTests(html, realRunId, cases);
  assert.equal(report.failed, 0, JSON.stringify(report.failures, null, 2));
  assert.equal(report.passed, 3);
  console.log("  ✓ 每条用例使用独立空数据空间");
  console.log("  ✓ aria 标签优先于整行模糊文字匹配");
  console.log("  ✓ jsdom 不支持的现代 CSS 不会被误判成应用崩溃");

  const realRows = await handleAppData(realRunId, "todos", "GET", undefined);
  assert.deepEqual(realRows.body, []);
  console.log("  ✓ QA 不污染真实应用数据空间");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
