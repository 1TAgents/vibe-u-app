/**
 * 派单预算。
 *
 * 这层要守住的是「动态调度不会无限循环」,而且要在**正确的时机**刹车 ——
 * 刹早了会误伤正常的多轮协作,刹晚了钱已经烧掉。所以三档上限各测一次,
 * 外加两条容易写错的边界:
 *   · 顺利推进的轮次不该被「同签名」规则误伤(没有失败就没有签名)
 *   · 换了角色之后连派计数要归零,不能累加成永远的黑名单
 */

import assert from "node:assert/strict";
import {
  DEFAULT_LIMITS,
  checkDispatch,
  describe,
  emptyBudget,
  failureSignature,
  record,
  spend,
} from "../src/lib/budget";

let passed = 0;
function ok(label: string) {
  passed++;
  console.log(`Budget · ✓ ${label}`);
}

/* --- 总轮次 --- */
{
  let b = emptyBudget();
  for (let i = 0; i < DEFAULT_LIMITS.maxDispatches; i++) {
    // 轮流换人,避免撞上连派上限
    b = spend(b, i % 2 === 0 ? "engineer" : "architect");
  }
  const r = checkDispatch(b, "engineer");
  assert.equal(r.allowed, false, "用满 20 轮必须拦");
  assert.equal(r.allowed === false && r.kind, "dispatches");
  assert.match(
    r.allowed === false ? r.reason : "",
    /交给人/,
    "拦下来要说清接下来该怎么办,不是只说不行",
  );
  ok(`总轮次用满 ${DEFAULT_LIMITS.maxDispatches} 轮后拦下`);
}

/* --- 同角色连派 --- */
{
  let b = emptyBudget();
  for (let i = 0; i < DEFAULT_LIMITS.maxSameRole; i++) b = spend(b, "engineer");
  const r = checkDispatch(b, "engineer");
  assert.equal(r.allowed, false, "连着派同一个人到上限必须拦");
  assert.equal(r.allowed === false && r.kind, "same-role");
  ok(`同角色连派 ${DEFAULT_LIMITS.maxSameRole} 次后拦下`);
}

/* --- 换人之后连派计数归零 --- */
{
  let b = emptyBudget();
  b = spend(b, "engineer");
  b = spend(b, "engineer");
  b = spend(b, "architect"); // 换人
  const r = checkDispatch(b, "engineer");
  assert.equal(r.allowed, true, "换过人之后再派回来,不该被之前的连派计数拖累");
  assert.equal(b.sameRoleStreak, 1, "换人后连派计数归零");
  ok("换人后连派计数归零(不是永久黑名单)");
}

/* --- 同签名复现 --- */
{
  const sig = failureSignature(["登录用例:第 7 步 找不到「张三 查看」"]);
  let b = emptyBudget();
  for (let i = 0; i < DEFAULT_LIMITS.maxSignature; i++) {
    // 换着人派,单独验签名这一档
    b = spend(b, i % 2 === 0 ? "engineer" : "architect", sig);
  }
  const r = checkDispatch(b, "designer", sig);
  assert.equal(r.allowed, false, "同一个失败原样复现到上限必须拦");
  assert.equal(r.allowed === false && r.kind, "signature");
  ok(`同签名原样复现 ${DEFAULT_LIMITS.maxSignature} 次后拦下`);
}

/* --- 顺利推进的轮次不该被签名规则误伤 --- */
{
  const sig = failureSignature(["某个失败"]);
  let b = emptyBudget();
  for (let i = 0; i < 5; i++) b = spend(b, i % 2 === 0 ? "engineer" : "architect", sig);
  // 这一轮是正常推进,没有失败,所以不传签名
  const r = checkDispatch(b, "qa");
  assert.equal(r.allowed, true, "没有失败就不该拿历史签名去卡它");
  ok("正常推进的轮次不传签名,不被历史失败误伤");
}

/* --- 软线:过半之后提醒收敛,但不拦 --- */
{
  let b = emptyBudget();
  const soft = Math.ceil(DEFAULT_LIMITS.maxDispatches * 0.7);
  for (let i = 0; i < soft; i++) b = spend(b, i % 2 === 0 ? "engineer" : "architect");
  const r = checkDispatch(b, "qa");
  assert.equal(r.allowed, true, "软线只提醒,不拦");
  assert.ok(r.allowed === true && r.warn, "过了软线要给出收敛提示");
  assert.match(r.allowed === true ? (r.warn ?? "") : "", /收敛|交给人/);
  ok("过软线只提醒收敛,不阻断");
}

/* --- 余额是只读文字,调度器看得见但改不了 --- */
{
  let b = emptyBudget();
  b = spend(b, "engineer");
  b = spend(b, "engineer");
  b = record(b, { totalTokens: 61067, costUsd: 0.0092 });
  const text = describe(b);
  assert.match(text, /还剩 18 轮/, "要说清还剩多少");
  assert.match(text, /连续 2 次/, "连派情况要可见 —— 它会影响决策");
  assert.match(text, /61\.1k token/, "用量只展示,不参与判定");
  assert.equal(typeof text, "string", "给出去的是文字,不是可写结构");
  ok("余额渲染成只读文字(看得见,改不了)");
}

/* --- 签名要抹掉会变的数值,否则「修了没生效」永远不触发 --- */
{
  const a = failureSignature(["用例 A:第 7 步 金额应为 128.50,实际 0"]);
  const c = failureSignature(["用例 A:第 7 步 金额应为 256.00,实际 0"]);
  assert.equal(a, c, "只有数值不同的同一个缺陷,必须算同一个签名");

  const d = failureSignature(["用例 B:第 3 步 找不到「保存」"]);
  assert.notEqual(a, d, "不同的失败不能压成同一个签名");
  ok("签名抹掉运行期数值,同一缺陷跨轮次可比");
}

/* --- 纯函数:spend 不改原对象 --- */
{
  const b0 = emptyBudget();
  const b1 = spend(b0, "engineer", "sig");
  assert.equal(b0.dispatches, 0, "原状态不能被就地修改 —— 状态归事件流所有");
  assert.equal(b1.dispatches, 1);
  ok("spend/record 是纯函数,不就地改状态");
}

console.log(`\n全部通过:${passed} 项`);
