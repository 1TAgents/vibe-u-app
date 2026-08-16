/**
 * 忽略标签末尾会变的计数。
 *
 * 写测试计划时应用里一条数据都没有,筛选页签自然是「跟进中 0」;
 * 等用例真跑起来、造了一条记录,它已经是「跟进中 1」了。
 * 把计数写进 target 按构造就是脆的,而这类写法在跑批里反复出现。
 *
 * 但放宽有个硬边界:点错页签比点不到危险得多 —— 后面的断言会在**错误的数据集**上
 * 通过,得到一个看起来跑通了的错误用例。所以只在去掉计数后唯一命中时才认。
 */

import assert from "node:assert/strict";
import { runTests } from "../src/lib/testrunner";

let passed = 0;
function ok(label: string) {
  passed++;
  console.log(`StableLabel · ✓ ${label}`);
}

const tabs = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body><div id="root">
  <h1>客户</h1>
  <button data-id="t1">全部 3</button>
  <button data-id="t2">跟进中 1</button>
  <button data-id="t3">已成交 2</button>
  <div id="log">未选择</div>
  <script>
    document.querySelectorAll("button").forEach((b) => {
      b.onclick = () => { document.getElementById("log").textContent = "选中" + b.dataset.id; };
    });
  </script>
</div></body></html>`;

/** 去掉计数后两个页签同名 —— 必须拒绝猜测 */
const ambiguous = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body><div id="root">
  <h1>看板</h1>
  <button data-id="a">已完成 1</button>
  <button data-id="b">已完成 2</button>
  <div id="log">未选择</div>
  <script>
    document.querySelectorAll("button").forEach((b) => {
      b.onclick = () => { document.getElementById("log").textContent = "选中" + b.dataset.id; };
    });
  </script>
</div></body></html>`;

async function main() {
  /* --- 计数对不上仍能落到同一个页签 --- */
  {
    const r = await runTests(tabs, "sl1", [
      {
        name: "切到跟进中",
        steps: [
          { action: "click", target: "跟进中 0" },
          { action: "expectText", text: "选中t2" },
        ],
      },
    ]);
    assert.equal(
      r.failed,
      0,
      `「跟进中 0」应落到界面上的「跟进中 1」:${JSON.stringify(r.failures.map((f) => f.message))}`,
    );
    ok("计数变了仍能落到同一个页签(跟进中 0 → 跟进中 1)");
  }

  /* --- 放宽不能让它落到别的页签上 --- */
  {
    const r = await runTests(tabs, "sl2", [
      {
        name: "切到已成交却断言跟进中",
        steps: [
          { action: "click", target: "已成交 0" },
          { action: "expectText", text: "选中t2" },
        ],
      },
    ]);
    assert.equal(r.failed, 1, "点的是已成交,断言跟进中必须失败");
    ok("不会因为放宽就落到别的页签上");
  }

  /* --- 去掉计数后同名时如实报找不到 --- */
  {
    const r = await runTests(ambiguous, "sl3", [
      {
        name: "含糊的页签",
        steps: [{ action: "click", target: "已完成 9" }],
      },
    ]);
    assert.equal(r.failed, 1, "两个「已完成」都沾边时不能随便挑一个");
    assert.match(r.failures[0].message, /找不到/, "应如实说找不到");
    ok("去掉计数后同名时拒绝猜测(点错页签会让断言在错的数据集上通过)");
  }

  /* --- 精确命中优先,不被这一档抢走 --- */
  {
    const r = await runTests(tabs, "sl4", [
      {
        name: "精确写法",
        steps: [
          { action: "click", target: "已成交 2" },
          { action: "expectText", text: "选中t3" },
        ],
      },
    ]);
    assert.equal(
      r.failed,
      0,
      `精确写法必须走精确匹配:${JSON.stringify(r.failures.map((f) => f.message))}`,
    );
    ok("精确写法仍走精确匹配");
  }

  console.log(`\n全部通过:${passed} 项`);
}

main().catch((e) => {
  console.error("\n✗ 失败:", e);
  process.exit(1);
});
