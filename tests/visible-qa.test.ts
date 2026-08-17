/**
 * QA 可见性判定回归测试 —— 复现翻转卡片假阳的四个根因:
 *
 *   1. backfaceVisibility ≠ visibility:hidden —— 3D 翻转背面用 backface-visibility
 *      隐藏,jsdom 不该把它当成 visibility:hidden 而整面判不可见;
 *   2. 祖先 aria-hidden="true" 时,后代必须判为不可见;
 *   3. 隐藏面(aria-hidden/hidden/inert/display:none/visibility:hidden)的文字
 *      不参与 expectText / expectNoText，避免把输入提示误判为页面结果;
 *   4. role=button / <button> 元素可点击,纯 <div onClick> 不算语义可点击。
 */

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { isVisible, runTests, visibleTextOf, type TestCase } from "../src/lib/testrunner";

function elem(html: string): HTMLElement {
  const dom = new JSDOM(`<div id="wrap">${html}</div>`);
  return dom.window.document.getElementById("wrap")!.firstElementChild as HTMLElement;
}

// 1) backfaceVisibility: hidden 不等于 visibility: hidden
assert.equal(
  isVisible(elem(`<div style="backfaceVisibility: hidden">背面</div>`)),
  true,
  "backfaceVisibility 不应被判为隐藏",
);
assert.equal(
  isVisible(elem(`<div style="visibility: hidden">x</div>`)),
  false,
  "真正的 visibility: hidden 应判为隐藏",
);
assert.equal(
  isVisible(elem(`<div style="display: none">x</div>`)),
  false,
  "display: none 应判为隐藏",
);
console.log("Visible QA · ✓ backfaceVisibility ≠ visibility:hidden(属性名精确匹配)");

// 2) 祖先 aria-hidden / hidden / inert → 后代不可见
assert.equal(
  isVisible(elem(`<div aria-hidden="true"><button>保存</button></div>`).querySelector("button")!),
  false,
  "祖先 aria-hidden=true 时后代应判为不可见",
);
assert.equal(
  isVisible(elem(`<div hidden><button>保存</button></div>`).querySelector("button")!),
  false,
  "祖先 hidden 时后代应判为不可见",
);
assert.equal(
  isVisible(elem(`<div inert><button>保存</button></div>`).querySelector("button")!),
  false,
  "祖先 inert 时后代应判为不可见",
);
console.log("Visible QA · ✓ 祖先 aria-hidden/hidden/inert 使后代不可见");

// 3) 可见文本只拼可见叶子 —— 隐藏面文字不参与
{
  const dom = new JSDOM(
    `<div id="root"><button id="card"><span>hello</span><span aria-hidden="true">世界</span></button></div>`,
  );
  const root = dom.window.document.getElementById("root")!;
  const visible = visibleTextOf(root);
  assert.ok(visible.includes("hello"), "可见面文字应保留");
  assert.ok(!visible.includes("世界"), "aria-hidden 面文字不应参与可见文本");
}
console.log("Visible QA · ✓ visibleTextOf 只拼可见叶子文本");

// 4) 端到端:翻转卡片 + 动态 aria-hidden → expectText/expectNoText 按可见面判定,role=button 可点击
const html = `<!doctype html>
<html><body><div id="root">
  <button id="card" role="button">
    <span id="front">hello</span>
    <span id="back" aria-hidden="true">世界</span>
  </button>
</div>
<script>
  const card = document.getElementById("card");
  const front = document.getElementById("front");
  const back = document.getElementById("back");
  card.addEventListener("click", () => {
    if (back.getAttribute("aria-hidden") === "true") {
      front.setAttribute("aria-hidden", "true");
      back.removeAttribute("aria-hidden");
    } else {
      back.setAttribute("aria-hidden", "true");
      front.removeAttribute("aria-hidden");
    }
  });
</script></body></html>`;

const cases: TestCase[] = [
  {
    name: "隐藏面文字不参与否定断言,翻面后按可见面切换",
    steps: [
      { action: "expectText", text: "hello" },
      { action: "expectNoText", text: "世界" }, // 背面 aria-hidden,不该出现
      { action: "click", target: "hello" }, // <button> 语义可点击
      { action: "expectNoText", text: "hello" }, // 翻面后正面隐藏
      { action: "expectText", text: "世界" }, // 背面可见
    ],
  },
];

async function main() {
  const report = await runTests(html, `visible-qa-${Date.now()}`, cases);
  assert.equal(report.failed, 0, JSON.stringify(report.failures, null, 2));
  assert.equal(report.passed, 1);
  console.log("Visible QA · ✓ 翻转卡片:aria-hidden 动态切换,否定/断言/点击按可见面判定");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
