/** 本地验证的 20 个代表性场景，覆盖 VibeU 的主要风险类型。 */
export interface Scenario {
  id: string;
  kind: "web-app" | "business-tool" | "calculator" | "landing-page";
  prompt: string;
  stresses: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "todo",
    kind: "web-app",
    prompt: "做一个待办清单，能新建任务、勾选完成、删除",
    stresses: "基础 CRUD 与空状态，作为整条流水线基线",
  },
  {
    id: "ledger",
    kind: "web-app",
    prompt: "做一个极简记账本，能记录收支、按分类统计本月结余",
    stresses: "聚合统计、正负数、本月口径与分类筛选",
  },
  {
    id: "notes",
    kind: "web-app",
    prompt: "做一个读书笔记应用，能添加书籍、写摘录、按书查看",
    stresses: "两个集合的关联、主从视图与编辑回显",
  },
  {
    id: "pomodoro",
    kind: "web-app",
    prompt: "做一个番茄钟，能开始计时、休息切换，并记录今天完成了几个番茄",
    stresses: "定时器生命周期、虚拟时间推进与完成态切换",
  },
  {
    id: "kanban",
    kind: "business-tool",
    prompt: "做一个团队看板，任务分待办、进行中、已完成三列，能新建和切换状态",
    stresses: "多列区域归属、状态迁移与旧列离开证据",
  },
  {
    id: "inventory",
    kind: "business-tool",
    prompt: "做一个库存管理，能录入商品、增减库存数量、低库存高亮提醒",
    stresses: "零边界、低库存语义状态和回弹闭环",
  },
  {
    id: "booking",
    kind: "business-tool",
    prompt: "做一个会议室预订，能选择房间和时间段预订，并看当天已预订情况",
    stresses: "同房间时间段冲突、当天筛选与动态日期",
  },
  {
    id: "poll",
    kind: "business-tool",
    prompt: "做一个投票收集，能创建选项、投票、实时看各选项票数和占比",
    stresses: "百分比、除零保护、精确票数和即时更新",
  },
  {
    id: "mortgage",
    kind: "calculator",
    prompt: "做一个房贷计算器，输入总价、首付比例、利率和年限，算出月供和总利息",
    stresses: "公式正确性、数值输入、金额格式化和异常边界",
  },
  {
    id: "coffee-site",
    kind: "landing-page",
    prompt: "做一个咖啡品牌官网，有品牌介绍、产品列表和留言板",
    stresses: "展示型视觉质量、导航可达性与留言持久化",
  },
  {
    id: "habit",
    kind: "web-app",
    prompt: "做一个习惯打卡应用，能新增习惯、每日打卡，并显示连续打卡天数",
    stresses: "连续天数口径、重复打卡保护与每日状态",
  },
  {
    id: "flashcard",
    kind: "web-app",
    prompt: "做一个单词卡应用，能新增卡片、翻面看释义、标记掌握并按状态筛选",
    stresses: "翻面可见性、掌握状态迁移与筛选结果",
  },
  {
    id: "recipe",
    kind: "web-app",
    prompt: "做一个菜谱收藏应用，能记录配料和步骤、添加标签，并按标签筛选",
    stresses: "结构化配料步骤、标签集合与筛选闭环",
  },
  {
    id: "workout",
    kind: "web-app",
    prompt: "做一个健身记录应用，能记录动作、组数和重量，并汇总本周训练量",
    stresses: "多个数值字段、重量聚合与本周时间口径",
  },
  {
    id: "crm",
    kind: "business-tool",
    prompt: "做一个客户跟进 CRM，能新增客户、写跟进备注、查看详情并标记成交",
    stresses: "列表详情联动、备注保存回显与成交状态",
  },
  {
    id: "leave",
    kind: "business-tool",
    prompt: "做一个请假审批应用，能提交请假、审批通过或驳回，并查看审批历史",
    stresses: "审批状态机、通过驳回分支与历史记录",
  },
  {
    id: "expense",
    kind: "business-tool",
    prompt: "做一个报销记录应用，能录入费用、按类别查看，并显示报销合计",
    stresses: "金额格式化、分类明细与合计一致性",
  },
  {
    id: "sales-dash",
    kind: "business-tool",
    prompt: "做一个销售看板，显示月度销售趋势、销售额和 Top 5 商品",
    stresses: "固定业务数据、月度趋势与 Top 5 排序",
  },
  {
    id: "weekly-report",
    kind: "business-tool",
    prompt: "做一个周报生成器，能填写本周完成、下周计划和风险，并复制导出文本",
    stresses: "多段文本状态、导出内容完整性与剪贴板能力",
  },
  {
    id: "bmi",
    kind: "calculator",
    prompt: "做一个 BMI 计算器，输入身高体重，显示 BMI、健康建议和历史记录",
    stresses: "BMI 公式、数值边界、建议区间与历史追加",
  },
];

export function scenarioById(id: string) {
  return SCENARIOS.find((scenario) => scenario.id === id);
}
