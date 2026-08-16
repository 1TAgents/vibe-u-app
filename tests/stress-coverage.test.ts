/** 场景压力覆盖护栏的确定性测试。 */

import assert from "node:assert/strict";
import { qaCaseText, qaStressGate, stressCovered } from "./stress-coverage";

// 基线场景无难点,恒覆盖
assert.deepEqual(stressCovered("todo", [{ cases: [{ name: "新建任务" }] }]).missing, []);
assert.equal(stressCovered("todo", [{ cases: [{ name: "新建任务" }] }]).covered, true);
console.log("Stress coverage · ✓ 基线场景恒覆盖");

// habit:只测「新建/打卡」骨架,不测连续天数 → 未覆盖难点
const coarse = stressCovered("habit", [
  { cases: [{ name: "能新建习惯" }, { name: "能每天打卡" }] },
]);
assert.equal(coarse.covered, false);
assert.ok(coarse.missing.some((s) => /连续|streak|天数|连签/.test(s)));
console.log("Stress coverage · ✓ habit 只测骨架时标记难点未覆盖");

// habit:用例真的碰到连续天数 → 覆盖
const thorough = stressCovered("habit", [
  { cases: [{ name: "能新建习惯" }, { name: "查看连续天数时跨天不中断" }] },
]);
assert.equal(thorough.covered, true);
assert.deepEqual(thorough.missing, []);
console.log("Stress coverage · ✓ habit 覆盖连续天数时判定通过");

// 失败原因也算进覆盖文本
const viaReason = stressCovered("habit", [
  { cases: [{ name: "打卡", ok: false, reason: "连续天数显示不对" }] },
]);
assert.equal(viaReason.covered, true);
console.log("Stress coverage · ✓ 失败原因同样计入覆盖文本");

// 未配置的场景(未来新增)不误杀
assert.equal(stressCovered("future-scenario", [{ cases: [{ name: "x" }] }]).covered, true);
console.log("Stress coverage · ✓ 未登记场景默认放行不误杀");

// qaCaseText 合并所有轮次与失败原因
const merged = qaCaseText([
  { cases: [{ name: "a", reason: "r1" }] },
  { cases: [{ name: "b" }] },
]);
assert.match(merged, /a r1/);
assert.match(merged, /\nb/);
console.log("Stress coverage · ✓ 多轮 QA 文本合并");

// ledger:三条规则必须同时命中 —— 只测统计不行,只测收入也不行
const onlyStats = stressCovered("ledger", [{ cases: [{ name: "统计本月结余" }] }]);
assert.equal(onlyStats.covered, false, "只测统计必须判定未覆盖");
assert.ok(onlyStats.missing.some((s) => /收入|正数/.test(s)), "缺失收入规则");
assert.ok(onlyStats.missing.some((s) => /支出|负数/.test(s)), "缺失支出规则");
console.log("Stress coverage · ✓ ledger 只测统计时被硬门拒绝(缺收入/支出)");

const onlyIncome = stressCovered("ledger", [{ cases: [{ name: "记录收入" }, { name: "统计本月结余" }] }]);
assert.equal(onlyIncome.covered, false, "只测收入+统计仍缺支出必须未覆盖");
assert.ok(onlyIncome.missing.some((s) => /支出|负数/.test(s)), "缺失支出规则");
console.log("Stress coverage · ✓ ledger 只测收入时被硬门拒绝(缺支出)");

// ledger 真实 QA 三条:统计/收入/支出全被用例文本覆盖 → 通过
const realLedgerQa = stressCovered("ledger", [
  { cases: [{ name: "记录一笔支出并验证统计" }, { name: "记录一笔收入并验证统计" }, { name: "按月筛选账单明细" }] },
]);
assert.equal(realLedgerQa.covered, true, "真实三条验收应全命中");
assert.deepEqual(realLedgerQa.missing, []);
console.log("Stress coverage · ✓ ledger 真实三条验收全命中(统计/收入/支出)");

// workout:三条语义(周聚合 / 组数 / 重量)必须逐条命中 —— 只有用例名喊「本周汇总」、
// 步骤却只保存、不碰组数/重量,过不了门。步骤是硬证据。
const nameOnly = stressCovered("workout", [
  {
    cases: [
      {
        name: "添加记录后验证本周汇总",
        steps: [
          { action: "fill", target: "动作", value: "深蹲" },
          { action: "click", target: "保存" },
          { action: "expectText", text: "保存成功" },
        ],
      },
    ],
  },
]);
assert.equal(nameOnly.covered, false, "只有名字喊本周汇总、步骤不触组数/重量必须未覆盖");
assert.ok(nameOnly.missing.some((s) => /组数|组/.test(s)), "缺失组数规则");
assert.ok(nameOnly.missing.some((s) => /重量|kg/.test(s)), "缺失重量规则");
console.log("Stress coverage · ✓ workout 名字喊本周汇总但步骤没碰组数/重量被拒");

// workout 真实用例:步骤真的断言了组数、重量与周汇总 → 全命中
const realWorkout = stressCovered("workout", [
  {
    cases: [
      {
        name: "添加杠铃深蹲记录并验证本周汇总与历史显示",
        steps: [
          { action: "fill", target: "动作", value: "深蹲" },
          { action: "fill", target: "组数", value: "3" },
          { action: "fill", target: "重量", value: "100" },
          { action: "click", target: "保存" },
          { action: "expectText", text: "本周 3 组 · 300kg" },
        ],
      },
    ],
  },
]);
assert.equal(realWorkout.covered, true, "真实 workout 用例步骤断言组数/重量/周汇总应通过");
assert.deepEqual(realWorkout.missing, []);
console.log("Stress coverage · ✓ workout 真实用例步骤断言组数/重量/周汇总通过");

// pomodoro:计时器 / 休息+完成计数 两条独立语义 —— 只喊「番茄计时」不碰完成计数被拒
const timerOnly = stressCovered("pomodoro", [
  { cases: [{ name: "番茄计时", steps: [{ action: "click", target: "开始专注" }] }] },
]);
assert.equal(timerOnly.covered, false, "只测计时器不测休息/完成计数必须未覆盖");
assert.ok(timerOnly.missing.some((s) => /休息|完成|计数|清零/.test(s)), "缺失完成计数规则");
console.log("Stress coverage · ✓ pomodoro 只测计时器被拒(缺休息/完成计数)");

// pomodoro 结构门:advanceTime 推进不足 25 分钟(只推 5 分钟)不算验证了计时终态 → 拒
const shortAdvance = stressCovered("pomodoro", [
  {
    cases: [
      {
        name: "倒计时开始专注后休息结束",
        steps: [
          { action: "click", target: "开始专注" },
          { action: "advanceTime", ms: 300_000 },
          { action: "expectText", text: "完成 1 个" },
        ],
      },
    ],
  },
]);
assert.equal(shortAdvance.covered, false, "advanceTime 不足 25 分钟必须未覆盖");
assert.ok(
  shortAdvance.missing.some((s) => /advanceTime/.test(s)),
  "应指出缺少 ≥1500 秒的 advanceTime 步骤证据",
);
console.log("Stress coverage · ✓ pomodoro 只推 5 分钟被拒(缺 25 分钟 advanceTime 步骤)");

// pomodoro 真实用例:计时器 + 完成计数 + advanceTime≥25 分钟证据全命中 → 通过
const realPomodoro = stressCovered("pomodoro", [
  {
    cases: [
      {
        name: "开始专注后推进 25 分钟验证完成态并计入今日番茄",
        steps: [
          { action: "click", target: "开始专注" },
          { action: "advanceTime", ms: 1_500_000 },
          { action: "expectText", text: "本阶段完成" },
          { action: "expectText", text: "完成 1 个" },
        ],
      },
      { name: "休息切换与今日完成计数" },
    ],
  },
]);
assert.equal(realPomodoro.covered, true, "真实 pomodoro 用例应命中计时器/完成计数/25分钟证据");
assert.deepEqual(realPomodoro.missing, []);
console.log("Stress coverage · ✓ pomodoro 真实用例命中计时器/完成计数/advanceTime 25分钟");

// kanban 结构门:区域归属只能靠 scoped assertion 证明 —— 全页面 expectText 假过。
// 只做全页面 expectText、没有 expectTextWithin → 拒
const kanbanGlobal = stressCovered("kanban", [
  {
    cases: [
      {
        name: "连续流转到已完成",
        steps: [
          { action: "fill", target: "新任务", value: "写周报" },
          { action: "click", target: "添加" },
          { action: "expectText", text: "写周报" },
          { action: "click", target: "将写周报移到下一列" },
          { action: "expectText", text: "写周报" },
        ],
      },
    ],
  },
]);
assert.equal(kanbanGlobal.covered, false, "只用全页面 expectText 无法证明列归属,必须未覆盖");
assert.ok(
  kanbanGlobal.missing.some((s) => /expectNoTextWithin|离开证据/.test(s)),
  "应指出缺区域断言与离开证据",
);
console.log("Stress coverage · ✓ kanban 只用全页面 expectText 被结构门拒绝");

// 有 scoped 断言,但只覆盖进行中、没到已完成 → 拒(链没走完)
const kanbanMidOnly = stressCovered("kanban", [
  {
    cases: [
      {
        name: "流转到进行中",
        steps: [{ action: "expectTextWithin", target: "进行中任务", text: "写周报" }],
      },
    ],
  },
]);
assert.equal(kanbanMidOnly.covered, false, "只断言进行中、未断言已完成必须未覆盖");
console.log("Stress coverage · ✓ kanban 只断言进行中列被拒(未走到已完成)");

// scoped 断言分散在两条用例里(每条从空数据开始,各自创建任务)→ 同一用例内没走完整链路 → 拒
const kanbanSplit = stressCovered("kanban", [
  {
    cases: [
      { name: "a", steps: [{ action: "expectTextWithin", target: "进行中任务", text: "写周报" }] },
      { name: "b", steps: [{ action: "expectTextWithin", target: "已完成任务", text: "读代码" }] },
    ],
  },
]);
assert.equal(kanbanSplit.covered, false, "同一任务文本必须在同一用例内先后出现在进行中与已完成");
console.log("Stress coverage · ✓ kanban 跨用例分散断言被拒(需同一用例内走完整链路)");

// 漏洞回归:两条纯负断言(进行中不应有 / 已完成不应有)没有证明任何迁移 → 拒
const kanbanPureNegatives = stressCovered("kanban", [
  {
    cases: [
      {
        name: "进行中与已完成都不应有写周报",
        steps: [
          { action: "expectNoTextWithin", target: "进行中任务", text: "写周报" },
          { action: "expectNoTextWithin", target: "已完成任务", text: "写周报" },
        ],
      },
    ],
  },
]);
assert.equal(kanbanPureNegatives.covered, false, "纯负断言没有正向迁移证据,必须被拒");
assert.ok(
  kanbanPureNegatives.missing.some((s) => /正向断言/.test(s)),
  "应指出缺正向断言证据",
);
console.log("Stress coverage · ✓ kanban 两条纯负断言被结构门拒绝");

// 倒序:已完成的正向断言先于进行中 → 迁移方向不对 → 拒
const kanbanReversed = stressCovered("kanban", [
  {
    cases: [
      {
        name: "先看到已完成再看到进行中",
        steps: [
          { action: "expectTextWithin", target: "已完成任务", text: "写周报" },
          { action: "click", target: "将写周报移到上一列" },
          { action: "expectTextWithin", target: "进行中任务", text: "写周报" },
        ],
      },
    ],
  },
]);
assert.equal(kanbanReversed.covered, false, "进行中正向断言必须先于已完成,倒序必须被拒");
console.log("Stress coverage · ✓ kanban 倒序(已完成先于进行中)被拒");

// 无中间 click:两次正向断言之间没有迁移动作,纯断言链不成立 → 拒
const kanbanNoClick = stressCovered("kanban", [
  {
    cases: [
      {
        name: "进行中与已完成都断言但没点击迁移",
        steps: [
          { action: "expectTextWithin", target: "进行中任务", text: "写周报" },
          { action: "expectTextWithin", target: "已完成任务", text: "写周报" },
        ],
      },
    ],
  },
]);
assert.equal(kanbanNoClick.covered, false, "两次正向断言之间没有 click,必须被拒");
console.log("Stress coverage · ✓ kanban 无中间 click 迁移被拒");

// 缺离开证据:迁移到已完成,但没有对旧「进行中任务」列的 expectNoTextWithin → 拒
const kanbanNoLeave = stressCovered("kanban", [
  {
    cases: [
      {
        name: "流转到已完成但没断言离开进行中",
        steps: [
          { action: "expectTextWithin", target: "进行中任务", text: "写周报" },
          { action: "click", target: "将写周报移到下一列" },
          { action: "expectTextWithin", target: "已完成任务", text: "写周报" },
        ],
      },
    ],
  },
]);
assert.equal(kanbanNoLeave.covered, false, "缺旧进行中列的离开负断言,必须被拒");
console.log("Stress coverage · ✓ kanban 缺「进行中任务」离开证据被拒");

// 真实 kanban QA:同一用例内同一任务文本,先「进行中任务」正向 → click 迁移 →
// 「已完成任务」正向 → 对旧「进行中任务」列 expectNoTextWithin 离开证据 → 通过
const kanbanScoped = stressCovered("kanban", [
  {
    cases: [
      {
        name: "连续流转到已完成并验证各列归属",
        steps: [
          { action: "expectTextWithin", target: "进行中任务", text: "写周报" },
          { action: "click", target: "将写周报移到下一列" },
          { action: "expectTextWithin", target: "已完成任务", text: "写周报" },
          { action: "expectNoTextWithin", target: "进行中任务", text: "写周报" },
        ],
      },
    ],
  },
]);
assert.equal(kanbanScoped.covered, true, "真实迁移链路(正向→click→正向→离开证据)应通过");
assert.deepEqual(kanbanScoped.missing, []);
console.log("Stress coverage · ✓ kanban 真实迁移链路(正向→click→正向→离开证据)通过");

// crm 结构门:要的是「编辑真的存住了」这件事被验证过,不是用了某个特定断言动作。
// 只喊口号、没有任何持久化证据(既没读回字段值,也没断言填进去的内容still在)→ 拒
const crmNoValue = stressCovered("crm", [
  {
    cases: [
      {
        name: "记录跟进备注",
        steps: [
          { action: "fill", target: "跟进备注", value: "已电话联系" },
          { action: "click", target: "保存" },
          { action: "expectTextWithin", target: "客户详情", text: "客户信息" },
        ],
      },
    ],
  },
]);
assert.equal(crmNoValue.covered, false, "断言的不是填进去的内容,证明不了存住了");
console.log("Stress coverage · ✓ crm 只断言无关文案不算持久化证据");

// 备注保存后渲染为详情文本(不再留在输入框)是合法实现 —— 断言的是真正填进去的
// 那段内容,就是有效证据。此前把它判死过两次,每次都白白烧掉一整场生成。
const crmText = stressCovered("crm", [
  {
    cases: [
      {
        name: "记录跟进备注",
        steps: [
          { action: "fill", target: "跟进备注", value: "已电话联系" },
          { action: "click", target: "保存" },
          { action: "expectTextWithin", target: "客户详情", text: "已电话联系" },
        ],
      },
    ],
  },
]);
assert.equal(crmText.covered, true, "断言填入内容仍在,是合格的持久化证据");
console.log("Stress coverage · ✓ crm 详情文本路径断言填入内容通过");

// 真实 crm QA:编辑态回显已保存的备注,用 expectValue 断言字段值 → 通过
const crmValue = stressCovered("crm", [
  {
    cases: [
      {
        name: "重新打开客户,跟进备注回显已保存内容",
        steps: [
          { action: "click", target: "王小美" },
          { action: "expectValue", target: "跟进备注", value: "已电话联系" },
        ],
      },
    ],
  },
]);
assert.equal(crmValue.covered, true, "expectValue 字段值断言应通过");
assert.deepEqual(crmValue.missing, []);
console.log("Stress coverage · ✓ crm 含 expectValue 字段值断言通过");

// 回归:这是跑批里 Vera 真实写出来、却被这道门连拒两轮、导致整场生成作废的计划。
// 它是教科书式的持久化验证 —— 填内容、保存、看见、离开列表、点回该客户、内容仍在。
// 唯一"问题"是用了全页面 expectText 而不是区域断言。拿断言的**形式**当证据,
// 三次用错的理由杀掉对的测试,每次的代价都是一整场生成。
const crmRealWorld = stressCovered("crm", [
  {
    cases: [
      {
        name: "在客户详情中添加跟进备注并保留",
        steps: [
          { action: "click", target: "录入客户" },
          { action: "fill", target: "客户姓名", value: "李四" },
          { action: "click", target: "保存客户" },
          { action: "click", target: "李四 添加备注" },
          { action: "fill", target: "记录一次沟通内容…", value: "电话沟通报价" },
          { action: "click", target: "李四 添加备注" },
          { action: "expectText", text: "电话沟通报价" },
          { action: "click", target: "返回列表" },
          { action: "click", target: "李四" },
          { action: "expectText", text: "电话沟通报价" },
        ],
      },
    ],
  },
]);
assert.equal(crmRealWorld.covered, true, "全页面 expectText 断言填入内容,同样是有效证据");
console.log("Stress coverage · ✓ crm 真实被误拒的计划(全页面 expectText)现在通过");

// 走完「保存 → 离开 → 重新进入」是更强的证据,当然也应通过。
// 它是提示词里引导 Vera 优先采用的写法,但不做成硬门 —— 卡到她写不出来,
// 代价是整场生成作废,而产品可能一个缺陷都没有。
const crmReenter = stressCovered("crm", [
  {
    cases: [
      {
        name: "跟进备注保存后重新打开仍在",
        steps: [
          { action: "click", target: "王小美" },
          { action: "fill", target: "跟进备注", value: "已电话联系" },
          { action: "click", target: "保存" },
          { action: "click", target: "李强" },
          { action: "click", target: "王小美" },
          { action: "expectTextWithin", target: "客户详情", text: "已电话联系" },
        ],
      },
    ],
  },
]);
assert.equal(crmReenter.covered, true, "离开再回来仍能看到填入内容,是合格的持久化证据");
console.log("Stress coverage · ✓ crm 详情文本路径:离开再回来断言通过");


// 回归:这是跑批里 Vera 真实交出、却被这道门连拒两轮、导致整场作废的计划。
// 结构上一条不缺 —— 源列断言、click 迁移、目标列断言、对源列的离开证据 ——
// 只是走的是「待办→进行中」而不是门里写死的「进行中→已完成」,列名也照界面叫「待办列」。
// 门该检查流转的形状,不是特定两列的名字。
const kanbanOtherColumns = stressCovered("kanban", [
  {
    cases: [
      {
        name: "将任务从待办列切换到进行中列",
        steps: [
          { action: "click", target: "待办 新建任务" },
          { action: "fill", target: "输入任务标题", value: "设计登录页" },
          { action: "click", target: "保存任务" },
          { action: "expectTextWithin", target: "待办列", text: "设计登录页" },
          { action: "click", target: "设计登录页 移动到进行中" },
          { action: "expectTextWithin", target: "进行中列", text: "设计登录页" },
          { action: "expectNoTextWithin", target: "待办列", text: "设计登录页" },
        ],
      },
    ],
  },
]);
assert.equal(kanbanOtherColumns.covered, true, "任意两列之间的完整流转都算数");
console.log("Stress coverage · ✓ kanban 真实被误拒的计划(待办→进行中)现在通过");

// 但仍要拒「换了个列名却没真的迁移」:两次断言落在同一列,不构成流转
const kanbanSameColumn = stressCovered("kanban", [
  {
    cases: [
      {
        name: "假流转",
        steps: [
          { action: "expectTextWithin", target: "待办列", text: "设计登录页" },
          { action: "click", target: "随便点点" },
          { action: "expectTextWithin", target: "待办列", text: "设计登录页" },
          { action: "expectNoTextWithin", target: "待办列", text: "设计登录页" },
        ],
      },
    ],
  },
]);
assert.equal(kanbanSameColumn.covered, false, "同一列内的两次断言证明不了迁移");
console.log("Stress coverage · ✓ kanban 同列断言不算流转(放宽没放水)");

// inventory 结构门:数量边界(减到 0 不得为负)+ 语义状态标记(出现又消失)必须同商品同用例完成。
// 只有文案「库存不足」、没有 expectAttribute 语义标记 → 拒(文案存在不等于视觉样式生效)
const invTextOnly = stressCovered("inventory", [
  {
    cases: [
      {
        name: "数量减到 0 时出现库存不足",
        steps: [
          { action: "click", target: "减少" },
          { action: "expectValue", target: "数量", value: "0" },
          { action: "expectText", text: "库存不足" },
          { action: "click", target: "增加" },
          { action: "expectNoText", text: "库存不足" },
        ],
      },
    ],
  },
]);
assert.equal(invTextOnly.covered, false, "只有 expectText 文案、没有 expectAttribute 语义标记必须被拒");
assert.ok(invTextOnly.missing.some((s) => /语义标记/.test(s)), "应指出缺语义状态断言");
console.log("Stress coverage · ✓ inventory 只有 expectText「库存不足」被拒(缺语义状态标记)");

// 有语义标记但没把数量断言到 0(无零边界) → 拒
const invNoZero = stressCovered("inventory", [
  {
    cases: [
      {
        name: "数量增到 5 后 low 标记消失",
        steps: [
          { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
          { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(invNoZero.covered, false, "没有把数量断言到 0 必须未覆盖");
assert.ok(invNoZero.missing.some((s) => /数量断言到 0/.test(s)), "应指出缺零边界证据");
console.log("Stress coverage · ✓ inventory 无数量到 0 的零边界被拒");

// 漏洞回归:零边界的数量字段与状态标记不是同一商品(香蕉数量=0 + 苹果 low)→ 假过,拒
const invCrossProductZero = stressCovered("inventory", [
  {
    cases: [
      {
        name: "香蕉数量到 0 但低库存断言在苹果",
        steps: [
          { action: "expectValue", target: "香蕉 数量", value: "0" },
          { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
          { action: "click", target: "苹果 增加" },
          { action: "expectValue", target: "苹果 数量", value: "1" },
          { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(invCrossProductZero.covered, false, "香蕉数量=0 + 苹果 low 必须被拒(零边界跨商品)");
assert.ok(invCrossProductZero.missing.some((s) => /同对象|同 target/.test(s)), "应指出缺同商品证据");
console.log("Stress coverage · ✓ inventory 香蕉数量=0 + 苹果 low 被拒(零边界跨商品)");

// 漏洞回归:出现用 data-state、消失用 aria-invalid → attr 不一致,拒
const invCrossAttr = stressCovered("inventory", [
  {
    cases: [
      {
        name: "出现断言 data-state 消失断言 aria-invalid",
        steps: [
          { action: "expectValue", target: "苹果 数量", value: "0" },
          { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
          { action: "click", target: "苹果 增加" },
          { action: "expectValue", target: "苹果 数量", value: "1" },
          { action: "expectNoAttribute", target: "苹果", attr: "aria-invalid", value: "true" },
        ],
      },
    ],
  },
]);
assert.equal(invCrossAttr.covered, false, "出现与消失必须是同一 attr,跨 attr 必须被拒");
assert.ok(invCrossAttr.missing.some((s) => /同 attr/.test(s)), "应指出出现/消失 attr 不一致");
console.log("Stress coverage · ✓ inventory 出现 data-state、消失 aria-invalid 被拒(跨 attr)");

// 漏洞回归:只有两条属性断言(出现+消失)、中间没有 click 补货和数量回弹 → 拒
const invNoRebound = stressCovered("inventory", [
  {
    cases: [
      {
        name: "只有 low 出现与消失两条属性断言",
        steps: [
          { action: "expectValue", target: "苹果 数量", value: "0" },
          { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
          { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(invNoRebound.covered, false, "出现与消失之间没有 click 补货与数量回弹,必须被拒");
assert.ok(invNoRebound.missing.some((s) => /click 补货/.test(s)), "应指出缺补货动作");
console.log("Stress coverage · ✓ inventory 两条属性断言间无补货/回弹被拒");

// 漏洞回归:low 标记先出现、数量后才断言到 0 → 触发顺序反了,拒(零边界必须发生在 low 出现之前)
const invZeroAfterAppear = stressCovered("inventory", [
  {
    cases: [
      {
        name: "low 标记先出现,数量后才断言到 0",
        steps: [
          { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
          { action: "expectValue", target: "苹果 数量", value: "0" },
          { action: "click", target: "苹果 增加" },
          { action: "expectValue", target: "苹果 数量", value: "1" },
          { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(invZeroAfterAppear.covered, false, "数量到 0 必须发生在 low 出现之前,先出现后 zero 必须被拒");
assert.ok(invZeroAfterAppear.missing.some((s) => /先于 low 出现/.test(s)), "应指出缺零边界前置证据");
console.log("Stress coverage · ✓ inventory low 先出现、zero 后出现被拒(触发顺序反了)");

// 漏洞回归:苹果 low,但中间补货 click 与数量回弹都是香蕉 → 不是同一商品的越过阈值证据,拒
const invCrossProductRebound = stressCovered("inventory", [
  {
    cases: [
      {
        name: "苹果出现 low 但中间补货的是香蕉",
        steps: [
          { action: "expectValue", target: "苹果 数量", value: "0" },
          { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
          { action: "click", target: "香蕉 增加" },
          { action: "expectValue", target: "香蕉 数量", value: "1" },
          { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(invCrossProductRebound.covered, false, "补货 click 与数量回弹必须属于同一商品(苹果),对香蕉补货必须被拒");
assert.ok(invCrossProductRebound.missing.some((s) => /click 补货/.test(s)), "应指出缺本商品补货证据");
console.log("Stress coverage · ✓ inventory 苹果 low 但中间给香蕉补货被拒(回弹跨商品)");

// 倒序:标记消失发生在出现之前 → 拒(顺序门)
const invReversed = stressCovered("inventory", [
  {
    cases: [
      {
        name: "low 标记先消失后出现",
        steps: [
          { action: "expectValue", target: "苹果 数量", value: "0" },
          { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
          { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(invReversed.covered, false, "标记消失先于出现,必须被拒");
console.log("Stress coverage · ✓ inventory 倒序(消失先于出现)被拒");

// 同对象门:出现与消失针对不同商品 → 拒(没证明同一商品的状态闭环)
const invDifferentObject = stressCovered("inventory", [
  {
    cases: [
      {
        name: "苹果出现 low、香蕉消失 low",
        steps: [
          { action: "expectValue", target: "苹果 数量", value: "0" },
          { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
          { action: "expectNoAttribute", target: "香蕉", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(invDifferentObject.covered, false, "出现与消失必须针对同一商品,跨对象必须被拒");
console.log("Stress coverage · ✓ inventory 跨商品断言被拒(需同对象闭环)");

// 真实 inventory QA:同一商品同一用例内,创建时 fill 阈值 → 数量到 0 → low 出现 →
// click 补货 + 回弹超过阈值 → low 消失 → 通过
const invReal = stressCovered("inventory", [
  {
    cases: [
      {
        name: "苹果数量减到 0 出现低库存,补货超过阈值后恢复",
        steps: [
          { action: "fill", target: "低库存阈值", value: "0" },
          { action: "click", target: "苹果 减少" },
          { action: "expectValue", target: "苹果 数量", value: "0" },
          { action: "click", target: "苹果 减少" },
          { action: "expectValue", target: "苹果 数量", value: "0" },
          { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
          { action: "click", target: "苹果 增加" },
          { action: "expectValue", target: "苹果 数量", value: "1" },
          { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(invReal.covered, true, "阈值设定 + 零边界 + 同对象语义标记出现又消失 + 回弹超阈值应通过");
assert.deepEqual(invReal.missing, []);
console.log("Stress coverage · ✓ inventory 同对象闭环(fill 阈值 0 → 0→low→补货回弹 1>0→low 消失)通过");

// 真实 inventory QA(只读数值展示版):数量以 div 文本渲染时,零边界与回弹用
// expectNumberWithin 断言数值 —— 门必须同样接受,不要求 expectValue 输入框。
// 数值 target 用细粒度度量标签「苹果 当前库存」,不写整行区域。
const invRealNumber = stressCovered("inventory", [
  {
    cases: [
      {
        name: "苹果库存减到 0 触发低库存,补货回弹后恢复",
        steps: [
          { action: "fill", target: "低库存阈值", value: "0" },
          { action: "click", target: "苹果 减少" },
          { action: "expectNumberWithin", target: "苹果 当前库存", value: "0" },
          { action: "click", target: "苹果 减少" },
          { action: "expectNumberWithin", target: "苹果 当前库存", value: "0" },
          { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
          { action: "click", target: "苹果 增加" },
          { action: "expectNumberWithin", target: "苹果 当前库存", value: "1" },
          { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(
  invRealNumber.covered,
  true,
  "只读 div 数值展示用 expectNumberWithin 断言 0 与回弹也应通过库存门",
);
assert.deepEqual(invRealNumber.missing, []);
console.log("Stress coverage · ✓ inventory 接受 expectNumberWithin(只读 div 数值)闭环通过");

// 阈值=3 但回弹只到 1:1 未超过 3,补货后仍是 low —— 若只要求「回弹>0」就假过了,必须拒
const invThresholdMiss = stressCovered("inventory", [
  {
    cases: [
      {
        name: "阈值 3 但补货只回弹到 1,仍未脱离低库存",
        steps: [
          { action: "fill", target: "低库存阈值", value: "3" },
          { action: "click", target: "苹果 减少" },
          { action: "click", target: "苹果 减少" },
          { action: "expectNumberWithin", target: "苹果 当前库存", value: "0" },
          { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
          { action: "click", target: "苹果 增加" },
          { action: "expectNumberWithin", target: "苹果 当前库存", value: "1" },
          { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(invThresholdMiss.covered, false, "回弹 1 未超过阈值 3,必须被拒(不能只看 >0)");
assert.ok(invThresholdMiss.missing.some((s) => /阈值/.test(s)), "应指出回弹需超过设定阈值");
console.log("Stress coverage · ✓ inventory 阈值 3 回弹 1 被拒(回弹需超过阈值,不止 >0)");

// 阈值=1 但回弹到 2:2 > 1,真正越过阈值 → 通过
const invThresholdPass = stressCovered("inventory", [
  {
    cases: [
      {
        name: "阈值 1,补货回弹到 2 才脱离低库存",
        steps: [
          { action: "fill", target: "低库存阈值", value: "1" },
          { action: "click", target: "苹果 减少" },
          { action: "click", target: "苹果 减少" },
          { action: "expectNumberWithin", target: "苹果 当前库存", value: "0" },
          { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
          { action: "click", target: "苹果 增加" },
          { action: "click", target: "苹果 增加" },
          { action: "expectNumberWithin", target: "苹果 当前库存", value: "2" },
          { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(invThresholdPass.covered, true, "阈值 1 回弹到 2(超过阈值)应通过");
assert.deepEqual(invThresholdPass.missing, []);
console.log("Stress coverage · ✓ inventory 阈值 1 回弹 2(超过阈值)通过");

// 数值 target 只写整行商品「苹果」、不含度量语义(数量/库存/金额…)→ 拒:
// 同一行可能同时有「当前库存 2」和「阈值 0」,整行数值断言会命中阈值造成假过。
const invRowTarget = stressCovered("inventory", [
  {
    cases: [
      {
        name: "数值断言只写商品整行,不含度量语义",
        steps: [
          { action: "fill", target: "低库存阈值", value: "0" },
          { action: "click", target: "苹果 减少" },
          { action: "expectNumberWithin", target: "苹果", value: "0" },
          { action: "expectAttribute", target: "苹果", attr: "data-state", value: "low" },
          { action: "click", target: "苹果 增加" },
          { action: "expectNumberWithin", target: "苹果", value: "1" },
          { action: "expectNoAttribute", target: "苹果", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(
  invRowTarget.covered,
  false,
  "数值 target 只写整行商品(无数量/库存等度量语义)必须被拒",
);
assert.ok(
  invRowTarget.missing.some((s) => /度量语义/.test(s)),
  "应指出缺度量语义的数值 target",
);
console.log("Stress coverage · ✓ inventory 数值 target 只写整行商品被拒(需度量语义)");

// 同商品名判定回归:创建商品时 fill「商品名称」→「苹果」,行 aria-label「商品 苹果」与
// 数值 aria-label「苹果 当前库存」规范化后互相都不包含(「商品苹果」vs「苹果当前库存」),
// 必须借提取出的商品名判同一商品 —— 否则合法的同商品闭环会被误判跨商品而拒绝(假阴性)。
const invSameProductNames = stressCovered("inventory", [
  {
    cases: [
      {
        name: "创建苹果,库存减到 0 触发低库存,补货回弹后恢复",
        steps: [
          { action: "fill", target: "商品名称", value: "苹果" },
          { action: "fill", target: "低库存阈值", value: "1" },
          { action: "click", target: "苹果 出库" },
          { action: "expectNumberWithin", target: "苹果 当前库存", value: "0" },
          { action: "expectAttribute", target: "商品 苹果", attr: "data-state", value: "low" },
          { action: "click", target: "苹果 补货" },
          { action: "expectNumberWithin", target: "苹果 当前库存", value: "2" },
          { action: "expectNoAttribute", target: "商品 苹果", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(
  invSameProductNames.covered,
  true,
  "「商品 苹果」与「苹果 当前库存」共享提取商品名「苹果」应判同一商品,闭环必须通过",
);
assert.deepEqual(invSameProductNames.missing, []);
console.log("Stress coverage · ✓ inventory 商品名提取:行标签「商品 苹果」与数值「苹果 当前库存」判同一商品,闭环通过");

// 反例:即使有商品名提取,苹果的低库存断言与香蕉的零边界/补货仍跨商品 → 拒(修复不引入假阳性)
const invCrossProductNames = stressCovered("inventory", [
  {
    cases: [
      {
        name: "创建香蕉,香蕉库存到 0,但低库存断言在苹果",
        steps: [
          { action: "fill", target: "商品名称", value: "香蕉" },
          { action: "fill", target: "低库存阈值", value: "1" },
          { action: "click", target: "香蕉 出库" },
          { action: "expectNumberWithin", target: "香蕉 当前库存", value: "0" },
          { action: "expectAttribute", target: "商品 苹果", attr: "data-state", value: "low" },
          { action: "click", target: "香蕉 补货" },
          { action: "expectNumberWithin", target: "香蕉 当前库存", value: "2" },
          { action: "expectNoAttribute", target: "商品 苹果", attr: "data-state", value: "low" },
        ],
      },
    ],
  },
]);
assert.equal(
  invCrossProductNames.covered,
  false,
  "商品名「香蕉」不与「商品 苹果」共享,苹果的低库存断言必须被拒(仍跨商品)",
);
console.log("Stress coverage · ✓ inventory 有商品名提取仍跨商品(香蕉闭环 + 苹果断言)被拒");

// ---- qaStressGate 硬门:covered=false 必须拒绝并列出缺失难点 ----
const gateOk = qaStressGate(true, []);
assert.equal(gateOk.ok, true);
assert.equal(gateOk.reason, undefined);
console.log("Stress gate · ✓ covered=true 直接放行");

const gateBlocked = qaStressGate(false, ["结余|合计|本月|统计|收支", "正|负"]);
assert.equal(gateBlocked.ok, false, "难点未覆盖必须拒绝");
assert.ok(gateBlocked.reason?.includes("结余|合计|本月|统计|收支"), "reason 应列出缺失难点正则");
assert.ok(gateBlocked.reason?.includes("正|负"), "多个缺失难点都应列出");
assert.ok(!gateBlocked.reason?.includes("undefined"), "reason 不应混入 undefined");
console.log("Stress gate · ✓ covered=false 拒绝放行并列出缺失难点");
