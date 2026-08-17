import assert from "node:assert/strict";
import { runTests } from "../src/lib/testrunner";

async function main() {
  const html = `<!doctype html><html><body>
    <button id="save">保存</button><p id="status"></p>
    <script>
      document.querySelector('#save').addEventListener('click', () => {
        document.querySelector('#status').textContent = '收入已保存';
      });
    </script>
  </body></html>`;
  const report = await runTests(html, "action-alias", [{
    name: "动作加对象可定位唯一真实按钮",
    steps: [
      { action: "click", target: "保存收入" },
      { action: "expectText", text: "收入已保存" },
    ],
  }]);
  assert.equal(report.failed, 0, report.failures[0]?.message);
  console.log("Action alias · ✓ 保存收入唯一映射到保存按钮");
}

void main();
