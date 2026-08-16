/**
 * 「记录名 + 动作」的组合定位。
 *
 * 一个列表里每条记录都有「编辑」「删除」,光说「编辑」是有歧义的,所以测试
 * 必须指明是哪一条。但实现侧未必把记录名写进 aria-label —— 跑批里反复出现的
 * 失败正是这个:测试写「城外的人想进去 编辑」,实现只在那一行里放了个纯文字
 * 「编辑」按钮。两边都没错,是表达方式没对齐。
 *
 * 所以这里验的是:这种写法要能落到**正确那一条**记录上,而且不能落错 ——
 * 定位错一条记录比定位不到更危险,那是会静默通过的假阳性。
 */

import assert from "node:assert/strict";
import { runTests } from "../src/lib/testrunner";

let passed = 0;
function ok(label: string) {
  passed++;
  console.log(`ScopedAction · ✓ ${label}`);
}

/** 两条记录,各自带一组纯文字操作按钮 —— 按钮上没有任何记录名信息 */
const listApp = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body><div id="root">
  <h1>摘录</h1>
  <ul>
    <li><span>城外的人想进去</span><button data-id="a1">编辑</button><button data-id="a2">删除</button></li>
    <li><span>生活不能等待别人</span><button data-id="b1">编辑</button><button data-id="b2">删除</button></li>
  </ul>
  <div id="log"></div>
  <script>
    document.querySelectorAll("button").forEach((b) => {
      b.onclick = () => { document.getElementById("log").textContent = "点了" + b.dataset.id; };
    });
  </script>
</div></body></html>`;


/** 状态标记挂在行内按钮上 —— 属性断言必须走同一套组合定位 */
const habitApp = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body><div id="root">
  <h1>习惯</h1>
  <ul>
    <li><span>晨跑</span><button aria-pressed="false" data-id="c1">打卡</button></li>
    <li><span>读书</span><button aria-pressed="true" data-id="c2">打卡</button></li>
  </ul>
  <script>
    document.querySelectorAll("button").forEach((b) => {
      b.onclick = () => b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
    });
  </script>
</div></body></html>`;


/** 每条记录自带一个审批意见框 —— 光说「审批意见」是有歧义的 */
const leaveApp = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body><div id="root">
  <h1>待审批</h1>
  <ul>
    <li><span>事假 2025.04.01</span><input placeholder="填写审批意见…" data-id="i1"><button>通过</button></li>
    <li><span>病假 2025.02.01</span><input placeholder="填写审批意见…" data-id="i2"><button>通过</button></li>
  </ul>
  <div id="log"></div>
  <script>
    document.querySelectorAll("input").forEach((el) => {
      el.oninput = () => { document.getElementById("log").textContent = el.dataset.id + "=" + el.value; };
    });
  </script>
</div></body></html>`;

async function main() {
  /* --- 落到正确的那一条 --- */
  {
    const r = await runTests(listApp, "s1", [
      {
        name: "编辑第一条",
        steps: [
          { action: "click", target: "城外的人想进去 编辑" },
          { action: "expectText", text: "点了a1" },
        ],
      },
      {
        name: "删除第二条",
        steps: [
          { action: "click", target: "生活不能等待别人 删除" },
          { action: "expectText", text: "点了b2" },
        ],
      },
    ]);
    assert.equal(r.failed, 0, `两条都应命中正确记录:${JSON.stringify(r.failures.map((f) => f.message))}`);
    assert.equal(r.passed, 2);
    ok("「记录名 动作」落到正确那一条记录上");
  }

  /* --- 不能落错记录(假阳性比失败更危险) --- */
  {
    const r = await runTests(listApp, "s2", [
      {
        name: "点第二条的编辑",
        steps: [
          { action: "click", target: "生活不能等待别人 编辑" },
          { action: "expectText", text: "点了a1" },
        ],
      },
    ]);
    assert.equal(r.failed, 1, "点的是 b1,断言 a1 必须失败,不能假过");
    ok("不会张冠李戴地落到别的记录上");
  }

  /* --- 记录名前面带实体前缀仍能定位 --- */
  {
    const r = await runTests(listApp, "s3", [
      {
        name: "带前缀写法",
        steps: [
          { action: "click", target: "摘录 城外的人想进去 编辑" },
          { action: "expectText", text: "点了a1" },
        ],
      },
    ]);
    assert.equal(r.failed, 0, `带前缀应仍能定位:${JSON.stringify(r.failures.map((f) => f.message))}`);
    ok("「摘录 城外的人想进去 编辑」这类带前缀写法也能落对");
  }

  /* --- 记录里没有这个动作时,如实失败 --- */
  {
    const r = await runTests(listApp, "s4", [
      {
        name: "不存在的动作",
        steps: [{ action: "click", target: "城外的人想进去 归档" }],
      },
    ]);
    assert.equal(r.failed, 1, "记录上没有「归档」就该失败");
    assert.match(r.failures[0].message, /找不到/, "应明确说找不到");
    ok("动作真的不存在时如实失败,不做兜底猜测");
  }


  /* --- 属性断言也要认「记录名 + 动作」--- */
  {
    const r = await runTests(habitApp, "s5", [
      {
        name: "打卡后该条变为已打卡",
        steps: [
          { action: "expectAttribute", target: "晨跑 打卡", attr: "aria-pressed", value: "false" },
          { action: "click", target: "晨跑 打卡" },
          { action: "expectAttribute", target: "晨跑 打卡", attr: "aria-pressed", value: "true" },
        ],
      },
    ]);
    assert.equal(
      r.failed,
      0,
      `属性断言应落到晨跑那一行的按钮:${JSON.stringify(r.failures.map((f) => f.message))}`,
    );
    ok("expectAttribute 认得「记录名 动作」,状态标记落到正确那一行");
  }

  /* --- 属性断言同样不能张冠李戴 --- */
  {
    const r = await runTests(habitApp, "s6", [
      {
        name: "读书本来就是已打卡",
        steps: [
          { action: "expectAttribute", target: "读书 打卡", attr: "aria-pressed", value: "false" },
        ],
      },
    ]);
    assert.equal(r.failed, 1, "读书是 true,断言 false 必须失败,不能落到晨跑那行上");
    ok("expectAttribute 不会落到别的记录上");
  }


  /* --- 输入框也要认「记录名 + 字段名」--- */
  {
    const r = await runTests(leaveApp, "s7", [
      {
        name: "给第二条填审批意见",
        steps: [
          { action: "fill", target: "病假 2025.02.01 审批意见", value: "同意" },
          { action: "expectText", text: "i2=同意" },
        ],
      },
    ]);
    assert.equal(
      r.failed,
      0,
      `应填进病假那一行的框:${JSON.stringify(r.failures.map((f) => f.message))}`,
    );
    ok("fill 认得「记录名 字段名」,填进正确那一行的输入框");
  }

  /* --- 填错框会得到一个看起来跑通的错误用例,必须避免 --- */
  {
    const r = await runTests(leaveApp, "s8", [
      {
        name: "填第一条却断言第二条",
        steps: [
          { action: "fill", target: "事假 2025.04.01 审批意见", value: "驳回" },
          { action: "expectText", text: "i2=驳回" },
        ],
      },
    ]);
    assert.equal(r.failed, 1, "填的是 i1,断言 i2 必须失败");
    ok("fill 不会张冠李戴填到别的记录上");
  }

  console.log(`\n全部通过:${passed} 项`);
}

main().catch((e) => {
  console.error("\n✗ 失败:", e);
  process.exit(1);
});
