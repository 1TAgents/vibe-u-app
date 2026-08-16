/**
 * target 可解析性预检。
 *
 * 这道门存在的意义是**把责任放对地方**:测试计划里编出来的控件名,
 * 该由写测试的人改,不该让写实现的人去猜。所以这里重点验两件事:
 *   1. 真编造的能拦下(否则门形同虚设)
 *   2. 合法写法一个都不误拦 —— 误拦会让 Vera 反复重写正确的计划,比漏拦更糟
 */

import assert from "node:assert/strict";
import { checkTargets } from "../src/lib/targetGate";
import type { TestCase } from "../src/lib/testrunner";

let passed = 0;
function ok(label: string) {
  passed++;
  console.log(`TargetGate · ✓ ${label}`);
}

const src = (content: string) => [{ path: "App.jsx", content }];

function tc(name: string, steps: TestCase["steps"]): TestCase {
  return { name, steps } as TestCase;
}

/* --- 真实失败复现:跑批里 Vera 编出来的那几个名字 --- */
{
  // poll 场景:PRD 只要求展示票数,Vera 却要求存在一个叫「露营 票数」的区域
  const r = checkTargets(
    [
      tc("参与投票", [
        { action: "fill", target: "选项名称", value: "露营" },
        { action: "click", target: "投票" },
        { action: "expectTextWithin", target: "露营 票数", text: "1 票" },
      ] as TestCase["steps"]),
    ],
    src(`<input placeholder="选项名称"/><button>投票</button><span>{o.name} · {o.votes} 票</span>`),
  );
  assert.equal(r.ok, false, "源码里没有「票数」这个可读名,应被拦下");
  assert.ok(r.problems[0].includes("票数"), "应指出具体是哪个词编造的");
  assert.ok(r.problems[0].includes("第 3 步"), "应定位到具体步骤");
  ok("拦下 poll 的「露营 票数」——「票数」源码里根本没有");
}

{
  // flashcard 场景:Vera 要求一个叫「卡片分组」的区域
  const r = checkTargets(
    [tc("已掌握分组", [{ action: "expectTextWithin", target: "卡片分组", text: "serendipity" }] as TestCase["steps"])],
    src(`<h2>待复习</h2><h2>已掌握</h2>`),
  );
  assert.equal(r.ok, false);
  ok("拦下 flashcard 的「卡片分组」——界面上只有「待复习」「已掌握」");
}

/* --- 合法写法不能误拦 --- */
{
  // 组合名:记录名是运行期填进去的数据,动作词来自源码 —— 这是被明确要求的写法
  const r = checkTargets(
    [
      tc("出库", [
        { action: "fill", target: "商品名称", value: "苹果" },
        { action: "click", target: "新增" },
        { action: "click", target: "苹果 出库" },
      ] as TestCase["steps"]),
    ],
    src('<input placeholder="商品名称"/><button>新增</button><button aria-label={`${p.name} 出库`}>出库</button>'),
  );
  assert.deepEqual(r.problems, [], "「填过的数据 + 源码里的动作词」是合法组合名");
  ok("不误拦「苹果 出库」这类合法组合名");
}

{
  // 实现只显示名称的一段(截断/取姓),不该因为对不上整串就判编造
  const r = checkTargets(
    [
      tc("审批", [
        { action: "fill", target: "申请人", value: "张伟" },
        { action: "click", target: "张 查看" },
      ] as TestCase["steps"]),
    ],
    src('<input placeholder="申请人"/><button aria-label={`${n} 查看`}>查看</button>'),
  );
  assert.deepEqual(r.problems, [], "填入值的子串不算编造");
  ok("不误拦填入值被截断显示的情况");
}

{
  // 没有 target 的步骤(等待、断言 URL 等)不该崩也不该报
  const r = checkTargets(
    [tc("空", [{ action: "wait", ms: 300 }] as unknown as TestCase["steps"])],
    src("<div/>"),
  );
  assert.deepEqual(r.problems, []);
  ok("无 target 的步骤安全跳过");
}

{
  // 源码里带引号/模板符号,归一化后仍应匹配得上
  const r = checkTargets(
    [tc("提交", [{ action: "click", target: "保存修改" }] as TestCase["steps"])],
    src(`<button className="btn">保存修改</button>`),
  );
  assert.deepEqual(r.problems, [], "源码里字面出现的按钮文案必须放行");
  ok("源码里字面存在的文案放行");
}

{
  // 全角/半角括号之差不是编造 —— 误拦会让 Vera 重写一版本来正确的计划
  const r = checkTargets(
    [tc("金额", [{ action: "fill", target: "金额(元)", value: "100" }] as TestCase["steps"])],
    src(`<input placeholder="金额(元)"/>`),
  );
  assert.deepEqual(r.problems, [], "标点差异不该判成编造");
  ok("标点/全角半角差异不误拦");
}


/* --- 门不能比执行器更严:执行器认得的写法必须放行 --- */
{
  // 真实回归:kanban 的「待办列」被拒,而执行器的宽松区域匹配完全能落到「待办」上。
  // 一次 20 场景跑批里 16 个失败有 5 个是这么误拒的,包括一直很稳的 kanban、ledger。
  const r = checkTargets(
    [tc("看板三列", [{ action: "expectTextWithin", target: "待办列", text: "写周报" }] as TestCase["steps"])],
    src(`<section aria-label="待办"><div>写周报</div></section>`),
    { names: ["待办", "进行中", "已完成"] },
  );
  assert.deepEqual(r.problems, [], "执行器能解析的区域名,门必须放行");
  ok("「待办列」不被误拒(门不比执行器更严)");
}

{
  // 组合写法同理:执行器会去那一行里找「编辑」
  const r = checkTargets(
    [
      tc("编辑记录", [
        { action: "fill", target: "标题", value: "读书笔记" },
        { action: "click", target: "读书笔记 编辑" },
      ] as TestCase["steps"]),
    ],
    src(`<input placeholder="标题"/><button>编辑</button>`),
    { names: ["编辑", "删除"] },
  );
  assert.deepEqual(r.problems, [], "「记录名 动作」执行器认得,门必须放行");
  ok("组合写法不被误拒");
}

{
  // 但真编造的仍要拦:界面上没有、源码里没有、也不是填入的数据
  const r = checkTargets(
    [tc("编造", [{ action: "expectTextWithin", target: "卡片分组", text: "x" }] as TestCase["steps"])],
    src(`<h2>待复习</h2><h2>已掌握</h2>`),
    { names: ["待复习", "已掌握"] },
  );
  assert.equal(r.ok, false, "界面上真的没有这个东西时仍要拦");
  ok("放宽后仍拦得住真正的编造");
}


{
  // 运行期才算出来的值:BMI 数值、日期、金额。它们不在源码、不在探查时的界面上
  // (那会儿还没有记录)、也不是填进去的,但运行时确实会出现。
  // 门看不见未来,对这类 token 就不该表态 —— 实测 bmi/booking 都是这么被误拒的。
  const r = checkTargets(
    [
      tc("删除历史记录", [
        { action: "click", target: "19.5 BMI 删除" },
        { action: "click", target: "选择 2025-08-14" },
      ] as TestCase["steps"]),
    ],
    src(`<button aria-label="BMI 删除">删除</button><button>选择</button>`),
    { names: ["BMI 删除", "选择"] },
  );
  assert.deepEqual(r.problems, [], "运行期计算出来的数值/日期不该判成编造");
  ok("运行期算出来的数值与日期不误拦(bmi/booking 实测形态)");
}

console.log(`\n全部通过:${passed} 项`);
