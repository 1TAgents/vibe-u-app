import type { RunState } from "./fold";

export interface DeliveryPromise {
  name: string;
  description: string;
  priority: "P0" | "P1" | "P2";
  testedBy: string[];
}

export interface DeliveryTestItem {
  name: string;
  covers: string[];
  status: "passed" | "failed" | "pending";
  reason?: string;
}

export interface DeliveryEvidenceItem {
  id: "build" | "audit" | "functional" | "acceptance";
  label: string;
  status: "passed" | "failed" | "pending";
  detail: string;
}

export interface DeliveryBoundary {
  tone: "warning" | "neutral";
  text: string;
}

export interface DeliverySummaryData {
  status: "ready" | "blocked" | "in_progress";
  promises: DeliveryPromise[];
  tests: DeliveryTestItem[];
  evidence: DeliveryEvidenceItem[];
  boundaries: DeliveryBoundary[];
  p0Covered: number;
  p0Total: number;
  passedTests: number;
  totalTests: number;
  passedEvidence: number;
}

/**
 * 把事件流里的产品承诺、测试计划和平台事实投影成一份老板能读的交付摘要。
 * 这里只做确定性映射，不调用模型，也不生成新的“完成”主张。
 */
export function buildDeliverySummary(state: RunState): DeliverySummaryData {
  const plannedCases = state.testCases ?? [];
  const lastQa = state.qaHistory.at(-1);
  const accept = state.accepts.at(-1);
  const lastBuild = state.buildHistory.at(-1);
  const latestAudit = latestGate(state, "static-audit");

  const promises: DeliveryPromise[] = (state.prd?.coreFeatures ?? []).map((feature) => ({
    ...feature,
    testedBy: plannedCases
      .filter((test) => test.covers?.includes(feature.name))
      .map((test) => test.name),
  }));

  const tests: DeliveryTestItem[] = plannedCases.map((test) => {
    const result = lastQa?.cases.find((item) => item.name === test.name);
    return {
      name: test.name,
      covers: test.covers ?? [],
      status: !result ? "pending" : result.ok ? "passed" : "failed",
      ...(result?.reason ? { reason: result.reason } : {}),
    };
  });

  const evidence: DeliveryEvidenceItem[] = [
    {
      id: "build",
      label: "真实构建",
      status: !lastBuild ? "pending" : lastBuild.ok ? "passed" : "failed",
      detail: !lastBuild
        ? "尚未执行服务端构建"
        : lastBuild.ok
          ? `${lastBuild.bytes ? `${Math.round(lastBuild.bytes / 1024)}KB · ` : ""}${lastBuild.durationMs}ms`
          : lastBuild.errors[0] ?? "构建未通过",
    },
    {
      id: "audit",
      label: "源码审计",
      status: !latestAudit ? "pending" : latestAudit.ok ? "passed" : "failed",
      detail: !latestAudit
        ? "尚未执行静态规则"
        : latestAudit.ok
          ? latestAudit.facts[0] ?? "适用规则全部通过"
          : latestAudit.facts[0] ?? "发现确定性缺陷",
    },
    {
      id: "functional",
      label: "功能验收",
      status: !lastQa ? "pending" : lastQa.failed === 0 ? "passed" : "failed",
      detail: !lastQa
        ? "尚未在运行应用上执行用例"
        : `${lastQa.passed}/${lastQa.passed + lastQa.failed} 条通过 · ${lastQa.durationMs}ms`,
    },
    {
      id: "acceptance",
      label: "交付验收",
      status: !accept ? "pending" : accept.accepted ? "passed" : "failed",
      detail: !accept
        ? "等待 Ida 核对功能、使用与视觉"
        : accept.accepted
          ? "功能 · 使用习惯 · 视觉均通过"
          : accept.summary || "产品负责人尚未同意交付",
    },
  ];

  const boundaries: DeliveryBoundary[] = [];
  const uncoveredP0 = promises.filter(
    (feature) => feature.priority === "P0" && feature.testedBy.length === 0,
  );
  if (uncoveredP0.length > 0) {
    boundaries.push({
      tone: "warning",
      text: `P0 尚未被验收用例覆盖：${uncoveredP0.map((item) => item.name).join("、")}`,
    });
  }

  for (const item of tests.filter((test) => test.status === "failed")) {
    boundaries.push({
      tone: "warning",
      text: `${item.name}：${item.reason ?? "最后一次执行未通过"}`,
    });
  }
  for (const issue of accept?.hardIssues ?? []) {
    boundaries.push({ tone: "warning", text: issue });
  }
  for (const issue of accept?.issues ?? []) {
    boundaries.push({
      tone: "warning",
      text: `${issue.problem}；期望：${issue.expectation}`,
    });
  }
  for (const audit of state.auditExhausted.slice(-1)) {
    boundaries.push(...audit.reasons.map((text) => ({ tone: "warning" as const, text })));
  }
  for (const suspect of state.infraSuspects.slice(-1)) {
    boundaries.push({
      tone: "warning",
      text: `疑似测试基础设施问题：${suspect.cases.join("、")}`,
    });
  }

  boundaries.push({
    tone: "neutral",
    text: `自动验收只证明上面列出的 ${tests.length} 条流程；未列出的组合、异常路径和数据规模不等于已经验证。`,
  });
  boundaries.push({
    tone: "neutral",
    text: "当前证据覆盖编译、DOM 交互和数据结果，不包含像素级视觉回归与跨浏览器兼容性测试。",
  });

  const dedupedBoundaries = boundaries.filter(
    (item, index, all) => all.findIndex((other) => other.text === item.text) === index,
  );
  const p0 = promises.filter((feature) => feature.priority === "P0");
  const p0Covered = p0.filter((feature) => feature.testedBy.length > 0).length;
  const passedEvidence = evidence.filter((item) => item.status === "passed").length;
  const hasFailure =
    evidence.some((item) => item.status === "failed") ||
    dedupedBoundaries.some((item) => item.tone === "warning");
  const allEvidencePassed = evidence.every((item) => item.status === "passed");

  return {
    status: hasFailure ? "blocked" : allEvidencePassed ? "ready" : "in_progress",
    promises,
    tests,
    evidence,
    boundaries: dedupedBoundaries.slice(0, 6),
    p0Covered,
    p0Total: p0.length,
    passedTests: lastQa?.passed ?? 0,
    totalTests: lastQa ? lastQa.passed + lastQa.failed : tests.length,
    passedEvidence,
  };
}

function latestGate(state: RunState, gate: string) {
  for (let index = state.gates.length - 1; index >= 0; index--) {
    if (state.gates[index].gate === gate) return state.gates[index];
  }
  return undefined;
}
