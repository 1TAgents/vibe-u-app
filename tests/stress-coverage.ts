/**
 * 场景压力覆盖护栏 —— 重导出 src/lib/stressCoverage.ts。
 *
 * 覆盖规则是 orchestrator(runTests 前的前置软门)与 runner(QA 后、verify/publish 前
 * 的外层硬门)共用的纯函数,已迁入 src/lib,这里保留旧路径兼容 runner 与既有测试。
 */
export {
  GUARDRAILS,
  STRUCTURAL_GATES,
  qaCaseText,
  stressCovered,
  qaStressGate,
  ensureCoverage,
} from "../src/lib/stressCoverage";
export type {
  QaStepLike,
  QaCaseLike,
  QaHistoryLike,
  CoverageLoopOptions,
  CoverageLoopResult,
} from "../src/lib/stressCoverage";
