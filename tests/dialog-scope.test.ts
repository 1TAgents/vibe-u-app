import assert from "node:assert/strict";
import { runTests } from "../src/lib/testrunner";

const html = `<!doctype html>
<html><body>
  <input placeholder="商品名称">
  <button id="behind">添加商品</button>
  <div role="dialog" aria-modal="true" aria-label="新增商品">
    <input id="modal-name" placeholder="商品名称">
    <button id="inside">添加商品</button>
  </div>
  <div id="result"></div>
  <script>
    document.querySelector('#behind').onclick = () => {
      document.querySelector('#result').textContent = '点错背景';
    };
    document.querySelector('#inside').onclick = () => {
      const value = document.querySelector('#modal-name').value;
      document.querySelector('#result').textContent = value + ' 已提交';
    };
  </script>
</body></html>`;

async function main() {
  const report = await runTests(html, "dialog-scope", [
    {
      name: "模态框优先于遮罩后的同名控件",
      steps: [
        { action: "fill", target: "商品名称", value: "苹果" },
        { action: "click", target: "添加商品" },
        { action: "expectText", text: "苹果 已提交" },
        { action: "expectNoText", text: "点错背景" },
      ],
    },
  ]);

  assert.equal(report.failed, 0, JSON.stringify(report.failures, null, 2));
  console.log("Dialog scope · ✓ 模态框内同名输入与按钮优先于遮罩后的页面控件");
}

void main();
