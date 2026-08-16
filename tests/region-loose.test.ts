/**
 * 区域名的宽松匹配。
 *
 * 区域名是描述性的,写测试的人几乎一定会带上「列表」「区域」「标签」这类后缀:
 * 界面标题是「待审批」,她写「待审批列表」。指的是同一个东西,却在全字相等
 * 这一关上一律判死 —— 跑批里这是剩下的头号失败类别。
 *
 * 但放宽有个硬边界:区域断言的全部价值就在「限定在哪个区域内」。
 * 含糊时挑一个,等于把这条断言的意义抽掉,还会**静默通过**。
 * 所以这里两类断言同等重要:该命中的要命中,该含糊的必须如实报找不到。
 */

import assert from "node:assert/strict";
import { runTests } from "../src/lib/testrunner";

let passed = 0;
function ok(label: string) {
  passed++;
  console.log(`RegionLoose · ✓ ${label}`);
}

const approvals = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body><div id="root">
  <h1>请假审批</h1>
  <section aria-label="待审批"><div>年假 · 张三</div></section>
  <section aria-label="已完成"><div>病假 · 李四</div></section>
</div></body></html>`;

/** 两个名字互相包含的区域 —— 正是必须拒绝含糊命中的场景 */
const ambiguous = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body><div id="root">
  <h1>看板</h1>
  <section aria-label="已完成"><div>写周报</div></section>
  <section aria-label="已完成任务"><div>读代码</div></section>
</div></body></html>`;

async function main() {
  /* --- 带描述性后缀仍能命中 --- */
  {
    const r = await runTests(approvals, "rl1", [
      {
        name: "待审批列表里有年假申请",
        steps: [{ action: "expectTextWithin", target: "待审批列表", text: "年假 · 张三" }],
      },
    ]);
    assert.equal(
      r.failed,
      0,
      `「待审批列表」应命中 aria-label「待审批」:${JSON.stringify(r.failures.map((f) => f.message))}`,
    );
    ok("「待审批列表」命中界面上的「待审批」区域");
  }

  /* --- 放宽不能放掉区域约束本身 --- */
  {
    const r = await runTests(approvals, "rl2", [
      {
        name: "已完成区域里不该有年假申请",
        steps: [{ action: "expectTextWithin", target: "已完成区域", text: "年假 · 张三" }],
      },
    ]);
    assert.equal(r.failed, 1, "文字在另一个区域里,必须失败 —— 否则区域断言就没意义了");
    ok("宽松匹配后区域约束依然成立(不会退化成全页面断言)");
  }

  /* --- 含糊时如实报找不到,不猜 --- */
  {
    const r = await runTests(ambiguous, "rl3", [
      {
        name: "含糊的区域名",
        steps: [{ action: "expectTextWithin", target: "已完成任务列表", text: "写周报" }],
      },
    ]);
    assert.equal(r.failed, 1, "「已完成」和「已完成任务」都被它包含,不能随便挑一个");
    assert.match(r.failures[0].message, /找不到区域/, "应如实说找不到区域");
    ok("命中多个互不包含的区域时拒绝猜测");
  }

  /* --- 精确名依然优先,不被宽松档抢走 --- */
  {
    const r = await runTests(ambiguous, "rl4", [
      {
        name: "精确区域名",
        steps: [{ action: "expectTextWithin", target: "已完成任务", text: "读代码" }],
      },
    ]);
    assert.equal(
      r.failed,
      0,
      `精确匹配必须优先:${JSON.stringify(r.failures.map((f) => f.message))}`,
    );
    ok("精确区域名仍走精确匹配,不受宽松档影响");
  }

  /* --- 带空格的文案:区域断言两边都必须归一化 --- */
  {
    const r = await runTests(approvals, "rl5", [
      {
        name: "区域内断言带空格的文案",
        steps: [{ action: "expectTextWithin", target: "待审批", text: "年假·张三" }],
      },
    ]);
    assert.equal(
      r.failed,
      0,
      `写法差一个空格不该判死:${JSON.stringify(r.failures.map((f) => f.message))}`,
    );
    ok("区域断言忽略空白差异(「年假 · 张三」≡「年假·张三」)");
  }

  /* --- 否定断言不能因为归一化漏做而恒真(静默假过) --- */
  {
    const r = await runTests(approvals, "rl6", [
      {
        name: "文字明明还在,否定断言必须失败",
        steps: [
          { action: "expectNoTextWithin", target: "待审批", text: "年假 · 张三" },
        ],
      },
    ]);
    assert.equal(
      r.failed,
      1,
      "文字就在区域里,expectNoTextWithin 必须失败 —— 恒真的否定断言是静默假阳性",
    );
    ok("否定断言不会因空白差异恒真(堵住静默假过)");
  }

  console.log(`\n全部通过:${passed} 项`);
}

main().catch((e) => {
  console.error("\n✗ 失败:", e);
  process.exit(1);
});
