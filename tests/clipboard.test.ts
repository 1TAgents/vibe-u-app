import assert from "node:assert/strict";
import { runTests } from "../src/lib/testrunner";

const html = `<!doctype html><html><body>
  <button id="copy">复制周报</button><p id="status"></p>
  <script>
    document.querySelector('#copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText('本周完成：修复验收流程');
      document.querySelector('#status').textContent = '已复制到剪贴板';
    });
  </script>
</body></html>`;

async function main() {
  const report = await runTests(html, "clipboard-shim", [{
    name: "复制文本后显示成功提示",
    covers: ["复制导出"],
    steps: [
      { action: "click", target: "复制周报" },
      { action: "expectText", text: "已复制到剪贴板" },
    ],
  }]);

  assert.equal(report.failed, 0, report.failures[0]?.message);
  console.log("Clipboard · ✓ jsdom 宿主支持异步复制并驱动成功状态");
}

void main();
