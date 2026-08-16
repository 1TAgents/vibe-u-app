/**
 * 派单预算 —— 动态调度唯一的真风险在这里兜住。
 *
 * 流程交给调度器现场决定之后,最容易死的方式是来回踢皮球:
 * 派给工程师 → 没修好 → 派给架构师 → 又派回工程师 → 烧完预算也不收敛。
 * 固定流程时顺序有限,这个问题不存在;动态调度必须自己长出刹车。
 *
 * 三条规则,每条都有理由:
 *
 *   ① 平台硬性执行,调度器看得见但改不了。
 *      和门同一条原则:它的职责是把预算花好,不是决定有多少预算。
 *      所以上限是模块常量,`check` 由编排层在派单**之前**调用,
 *      调度器只拿到 `describe()` 渲染出来的余额文字。
 *
 *   ② 要让它看见余额,因为余额会改变决策。
 *      剩 15 轮可以试探性地先改数据模型再让实现跟上;
 *      剩 2 轮就只做最高确定性的动作,或者直接把问题整理清楚交给人。
 *      这正是真实项目经理干的事 —— 初期可以试,快到 deadline 只做稳的。
 *
 *   ③ 耗尽 ≠ 失败。
 *      本模块只回答「还能不能再派一轮」,不回答「这次算成功还是失败」。
 *      已经有能跑的产物时,编排层应该交付当前最好的版本并说明遗留问题 ——
 *      老板宁可拿到一个有已知问题的东西,也不想拿到一句「运行失败」。
 *
 * 纯函数,无 I/O 无模型,可以完全脱离 LLM 单测。
 */

import type { NodeId } from "./events";

export interface BudgetLimits {
  /** 一级控制:总派单轮次。方差小、语义清楚 */
  maxDispatches: number;
  /** 连着派同一个人这么多次还没好,就该换人或找人 */
  maxSameRole: number;
  /** 同一个失败原样复现这么多次,停止自动派单 */
  maxSignature: number;
}

/**
 * token 不设硬线是刻意的:方差太大 —— 一次架构设计和一次改文案能差十倍,
 * 卡死会误伤正常的复杂需求,放松到不误伤又拦不住循环。轮次是更好的一级控制。
 * 先只记录,等积累了足够多 run 的分布再决定要不要设线。
 */
export const DEFAULT_LIMITS: BudgetLimits = Object.freeze({
  maxDispatches: 20,
  maxSameRole: 3,
  maxSignature: 3,
});

/** 余额低于这个比例就提醒调度器开始收敛,但不强制 */
const SOFT_LINE = 0.7;

export interface BudgetState {
  dispatches: number;
  /** 上一次派给了谁 —— 用来算连派 */
  lastRole: NodeId | null;
  sameRoleStreak: number;
  /** 失败签名 → 原样复现次数 */
  signatures: Record<string, number>;
  /** 只记录,不设线 */
  tokens: number;
  costUsd: number;
}

export function emptyBudget(): BudgetState {
  return {
    dispatches: 0,
    lastRole: null,
    sameRoleStreak: 0,
    signatures: {},
    tokens: 0,
    costUsd: 0,
  };
}

export type BudgetBlock = "dispatches" | "same-role" | "signature";

export type BudgetCheck =
  | { allowed: true; remaining: number; /** 过了软线时的提醒 */ warn?: string }
  | { allowed: false; kind: BudgetBlock; reason: string };

/**
 * 能不能再派这一轮 —— 编排层在派单**之前**问。
 *
 * signature 是本轮要处理的失败的归一化签名。没有失败(正常推进)时不传,
 * 那一档就不参与判定 —— 顺利往前走的轮次不该被「同签名」规则误伤。
 */
export function checkDispatch(
  state: BudgetState,
  next: NodeId,
  signature?: string,
  limits: BudgetLimits = DEFAULT_LIMITS,
): BudgetCheck {
  if (state.dispatches >= limits.maxDispatches) {
    return {
      allowed: false,
      kind: "dispatches",
      reason: `派单已用满 ${limits.maxDispatches} 轮。继续自动重试只会烧钱,` +
        `此刻更可能是需求本身有歧义或做不到,该交给人看。`,
    };
  }

  const streak = state.lastRole === next ? state.sameRoleStreak + 1 : 1;
  if (streak > limits.maxSameRole) {
    return {
      allowed: false,
      kind: "same-role",
      reason: `连续第 ${streak} 次派给同一个角色仍未解决。` +
        `再派下去多半还是同样的结果 —— 要么换一层去改,要么交给人。`,
    };
  }

  if (signature) {
    const seen = (state.signatures[signature] ?? 0) + 1;
    if (seen > limits.maxSignature) {
      return {
        allowed: false,
        kind: "signature",
        reason: `同一个失败原样复现第 ${seen} 次:「${signature.slice(0, 60)}」。` +
          `修了没生效,说明判断的方向不对,不该继续自动派单。`,
      };
    }
  }

  const remaining = limits.maxDispatches - state.dispatches;
  const spent = state.dispatches / limits.maxDispatches;
  return spent >= SOFT_LINE
    ? {
        allowed: true,
        remaining,
        warn: `预算只剩 ${remaining} 轮,优先收敛:做把握最大的那个动作,` +
          `或者把当前问题整理清楚交给人,不要再试探。`,
      }
    : { allowed: true, remaining };
}

/** 记一次派单。返回新状态,不改原对象 —— 状态由事件流拥有,这里只做纯计算 */
export function spend(
  state: BudgetState,
  next: NodeId,
  signature?: string,
): BudgetState {
  const signatures = { ...state.signatures };
  if (signature) signatures[signature] = (signatures[signature] ?? 0) + 1;
  return {
    ...state,
    dispatches: state.dispatches + 1,
    sameRoleStreak: state.lastRole === next ? state.sameRoleStreak + 1 : 1,
    lastRole: next,
    signatures,
  };
}

/** 累计用量。token 只记录,不参与任何判定 */
export function record(
  state: BudgetState,
  usage: { totalTokens: number; costUsd: number },
): BudgetState {
  return {
    ...state,
    tokens: state.tokens + usage.totalTokens,
    costUsd: state.costUsd + usage.costUsd,
  };
}

/**
 * 渲染给调度器看的余额。
 *
 * 刻意只给文字、不给可写结构 —— 它看得见,但没有任何途径改上限。
 * 这是规则 ① 的实现方式。
 */
export function describe(
  state: BudgetState,
  limits: BudgetLimits = DEFAULT_LIMITS,
): string {
  const remaining = limits.maxDispatches - state.dispatches;
  const lines = [
    `已派单 ${state.dispatches}/${limits.maxDispatches} 轮,还剩 ${remaining} 轮`,
  ];
  if (state.lastRole && state.sameRoleStreak > 1) {
    lines.push(
      `已连续 ${state.sameRoleStreak} 次派给同一角色(上限 ${limits.maxSameRole})`,
    );
  }
  const repeated = Object.entries(state.signatures).filter(([, n]) => n > 1);
  if (repeated.length > 0) {
    lines.push(
      `原样复现过的失败:${repeated
        .map(([sig, n]) => `「${sig.slice(0, 40)}」×${n}`)
        .join("、")}`,
    );
  }
  lines.push(`累计 ${(state.tokens / 1000).toFixed(1)}k token · $${state.costUsd.toFixed(4)}`);
  return lines.join("\n");
}

/**
 * 把一组门产出的事实压成稳定签名。
 *
 * 用途是判断「这次失败和上次是不是同一个」。所以要抹掉会变的部分:
 * 耗时、字节数、以及运行期才产生的数值(记录 id、金额、日期),
 * 否则同一个缺陷每轮都会算成新签名,「修了没生效」这条规则就永远不触发。
 */
export function failureSignature(facts: string[]): string {
  return facts
    .map((f) =>
      f
        .replace(/\d+(\.\d+)?/g, "#")
        .replace(/\s+/g, "")
        .slice(0, 80),
    )
    .sort()
    .join("|")
    .slice(0, 200);
}
