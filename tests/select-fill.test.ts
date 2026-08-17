import assert from "node:assert/strict";
import { runTests } from "../src/lib/testrunner";

const html = `<!doctype html>
<html><body>
  <label for="room">会议室</label>
  <select id="room" aria-label="会议室">
    <option value="">请选择</option>
    <option value="room-a">会议室A</option>
  </select>
  <div id="result"></div>
  <script>
    document.querySelector('#room').addEventListener('change', (event) => {
      document.querySelector('#result').textContent = event.target.value + ' 已选择';
    });
  </script>
</body></html>`;

async function main() {
  const report = await runTests(html, "select-fill", [
    {
      name: "原生选择框使用自己的 value setter",
      steps: [
        { action: "fill", target: "会议室", value: "会议室A" },
        { action: "expectValue", target: "会议室", value: "room-a" },
        { action: "expectText", text: "room-a 已选择" },
      ],
    },
  ]);

  assert.equal(report.failed, 0, JSON.stringify(report.failures, null, 2));
  console.log("Select fill · ✓ 原生 select 可按可见标签选择并触发 change");
}

void main();
