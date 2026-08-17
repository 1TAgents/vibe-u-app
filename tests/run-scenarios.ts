/**
 * VibeU 本地场景验证台。
 *
 * 每次只建议运行一个场景：生成结束后读取同一事件流，验证角色、门禁、功能验收、
 * 交付验收、场景难点、候选预览和本地公开应用。结果写入 tests/results，便于逐场景迭代。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { buildDeliverySummary } from "../src/lib/delivery-summary";
import type { Envelope, RunEvent } from "../src/lib/events";
import { foldEvents } from "../src/lib/fold";
import { stressCovered } from "../src/lib/stressCoverage";
import { SCENARIOS, type Scenario } from "./scenarios";

const BASE = process.env.BASE_URL ?? "http://localhost:3002";
const MODEL = process.env.MODEL ?? "deepseek-v4-flash";
const VERIFY_RUN_ID = process.env.VERIFY_RUN_ID?.trim();
// A full company-style loop can legitimately include implementation repair plus
// one or more QA-plan corrections. Ten minutes cut off a healthy run immediately
// after its functional tests passed, before acceptance and publication evidence
// could be recorded, so the local campaign gives the bounded workflow 20 minutes.
const RUN_TIMEOUT_MS = Number(process.env.SCENARIO_TIMEOUT_MS ?? 20 * 60 * 1000);
const MOUNT_WAIT_MS = 2600;

type Stage = "generate" | "roles" | "build" | "qa" | "accept" | "coverage" | "preview" | "publish" | "ok";

interface ScenarioResult {
  id: string;
  kind: Scenario["kind"];
  stresses: string;
  runId?: string;
  ok: boolean;
  stage: Stage;
  reason?: string;
  wallMs: number;
  tokens?: number;
  costUsd?: number;
  files?: number;
  dispatches?: number;
  roleChain?: string[];
  buildRetries?: number;
  qaRounds?: number;
  qaPassed?: number;
  qaFailed?: number;
  emmaAllocations?: number;
  parseRetries?: number;
  coverageRetries?: number;
  stressCovered?: boolean;
  missingStress?: string[];
  deliveryStatus?: "ready" | "blocked" | "in_progress";
  publicStage?: string;
  nonBlockingWarnings?: string[];
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const started = Date.now();
  const events: Envelope<RunEvent>[] = [];
  let runId: string | undefined;
  const fail = (stage: Stage, reason: string, extra: Partial<ScenarioResult> = {}): ScenarioResult => ({
    id: scenario.id,
    kind: scenario.kind,
    stresses: scenario.stresses,
    runId,
    ok: false,
    stage,
    reason,
    wallMs: Date.now() - started,
    ...extra,
  });

  try {
    if (VERIFY_RUN_ID) {
      runId = VERIFY_RUN_ID;
      const response = await fetch(`${BASE}/api/run/${VERIFY_RUN_ID}/events`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        return fail("generate", `读取既有 run 失败 HTTP ${response.status}`);
      }
      const payload = await response.json() as { events?: Envelope<RunEvent>[] };
      events.push(...(payload.events ?? []));
    } else {
      const res = await fetch(`${BASE}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: scenario.prompt,
          model: MODEL,
          autoApprove: true,
          scenarioId: scenario.id,
        }),
        signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      });
      if (!res.ok || !res.body) return fail("generate", `HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
      for await (const event of readSse(res.body)) {
        runId = event.runId;
        events.push(event);
      }
    }
  } catch (error) {
    return fail("generate", errorText(error));
  }

  const state = foldEvents(events);
  const base = {
    tokens: state.totals.totalTokens,
    costUsd: state.totals.costUsd,
    files: state.files.length,
    dispatches: state.budgetHistory.at(-1)?.dispatches ?? state.dispatches.length,
    parseRetries: state.parseRetries,
    coverageRetries: state.qaCoverageRetries.length,
  };

  if (state.aborted) return fail("generate", state.aborted, base);
  if (state.finished !== "succeeded") {
    const handoff = state.escalations.at(-1)?.reason;
    return fail("generate", handoff ?? `运行终态为 ${state.finished ?? "未收敛"}`, base);
  }
  if (!runId || state.files.length === 0) return fail("generate", "没有生成可运行文件", base);

  const roleChain = orderedDistinct(state.timeline.map((node) => node.id));
  const required = ["pm", "designer", "architect", "engineer", "qa", "accept"];
  const missingRoles = required.filter((role) => !roleChain.includes(role));
  if (missingRoles.length > 0) {
    return fail("roles", `角色链缺少 ${missingRoles.join("、")}`, { ...base, roleChain });
  }
  const index = (role: string) => roleChain.indexOf(role);
  if (!(index("pm") < index("designer") && index("designer") < index("architect") && index("architect") < index("engineer"))) {
    return fail("roles", "产品、视觉、架构、工程的首次产出顺序不正确", { ...base, roleChain });
  }

  const lastBuild = state.buildHistory.at(-1);
  const buildRetries = Math.max(0, state.buildHistory.length - 1);
  if (!lastBuild?.ok) {
    return fail("build", lastBuild?.errors[0] ?? "没有成功构建证据", { ...base, roleChain, buildRetries });
  }

  const lastQa = state.qaHistory.at(-1);
  const qaCommon = {
    ...base,
    roleChain,
    buildRetries,
    qaRounds: state.qaHistory.length,
    qaPassed: lastQa?.passed,
    qaFailed: lastQa?.failed,
    emmaAllocations: state.qaTriages.length,
  };
  if (!lastQa || lastQa.failed > 0) {
    return fail("qa", !lastQa ? "Tess 没有执行功能验收" : `最后一轮仍有 ${lastQa.failed} 条失败`, qaCommon);
  }

  const lastAccept = state.accepts.at(-1);
  if (!lastAccept?.accepted) {
    return fail("accept", lastAccept?.summary ?? "Ida 没有同意交付", qaCommon);
  }

  const stress = stressCovered(scenario.id, [{ cases: state.testCases ?? [] }]);
  if (!stress.covered) {
    return fail("coverage", `验收计划没有覆盖场景难点：${stress.missing.join("、")}`, {
      ...qaCommon,
      stressCovered: false,
      missingStress: stress.missing,
    });
  }

  const delivery = buildDeliverySummary(state);
  if (delivery.status !== "ready") {
    const warning = delivery.boundaries.find((item) => item.tone === "warning")?.text;
    return fail("accept", warning ?? `交付摘要状态为 ${delivery.status}`, {
      ...qaCommon,
      stressCovered: true,
      deliveryStatus: delivery.status,
    });
  }

  const candidate = await smokeApp(runId, true, "candidate");
  if (!candidate.ok) return fail("preview", candidate.reason ?? "候选预览未挂载", qaCommon);
  const published = await smokeApp(runId, false, "published");
  if (!published.ok) return fail("publish", published.reason ?? "公开应用未挂载", qaCommon);

  const nonBlockingWarnings = state.gates
    .filter((gate) => !gate.blocking && !gate.ok)
    .flatMap((gate) => gate.facts)
    .slice(0, 8);

  return {
    id: scenario.id,
    kind: scenario.kind,
    stresses: scenario.stresses,
    runId,
    ok: true,
    stage: "ok",
    wallMs: Date.now() - started,
    ...qaCommon,
    stressCovered: true,
    missingStress: [],
    deliveryStatus: delivery.status,
    publicStage: published.stage,
    nonBlockingWarnings,
  };
}

async function smokeApp(
  runId: string,
  embed: boolean,
  expectedStage: "candidate" | "published",
): Promise<{ ok: boolean; reason?: string; stage?: string }> {
  const url = `${BASE}/a/${runId}${embed ? "?embed=1" : ""}`;
  let html: string;
  let stage: string | undefined;
  try {
    const response = await fetch(url);
    // VibeU 已脱离旧 Atoms Glassbox 品牌；阶段响应头也已改名。
    // fetch 的 Headers 大小写不敏感，但名称本身必须读取当前契约，否则会把
    // 已正确返回的候选/公开 bundle 误报为「无阶段」。
    stage = response.headers.get("x-vibeu-bundle-stage") ?? undefined;
    html = await response.text();
    if (!response.ok) return { ok: false, stage, reason: `应用链接 HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, reason: `读取应用链接失败：${errorText(error)}` };
  }
  if (stage !== expectedStage) {
    return { ok: false, stage, reason: `期望 bundle=${expectedStage}，实际=${stage ?? "无"}` };
  }

  const reports: { kind: string; message: string }[] = [];
  const consoleErrors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => {
    // Tailwind 4 的现代 CSS（如 @property）超出 jsdom 26 的解析能力，真实浏览器
    // 可以正常解析；功能探针与 testrunner 保持同一降噪规则。
    if (error.message.includes("Could not parse CSS stylesheet")) return;
    consoleErrors.push(error.message);
  });
  const dom = new JSDOM(html, {
    url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      (window as unknown as { fetch: typeof fetch }).fetch = fetch;
      window.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as { __vibeu?: boolean; kind?: string; message?: string };
        if (data?.__vibeu) reports.push({ kind: data.kind ?? "unknown", message: data.message ?? "" });
      });
    },
  });
  await sleep(MOUNT_WAIT_MS);
  const text = (dom.window.document.getElementById("root")?.textContent ?? "").trim();
  dom.window.close();

  const bad = reports.find((report) => report.kind !== "ok");
  if (bad) return { ok: false, stage, reason: `[${bad.kind}] ${bad.message.slice(0, 180)}` };
  if (!reports.some((report) => report.kind === "ok")) {
    return { ok: false, stage, reason: `运行探针未回报${consoleErrors[0] ? `：${consoleErrors[0].slice(0, 140)}` : ""}` };
  }
  if (!text) return { ok: false, stage, reason: "应用挂载后没有可见文本" };
  return { ok: true, stage };
}

async function* readSse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((part) => part.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload) as Envelope<RunEvent>;
      } catch {
        // SSE 半帧留给下一批字节，不把传输切片误判为业务失败。
      }
    }
  }
}

function orderedDistinct(values: string[]) {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const scenarios = requested.length > 0
    ? SCENARIOS.filter((scenario) => requested.includes(scenario.id))
    : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`没有匹配的场景：${requested.join("、")}`);
  if (VERIFY_RUN_ID && scenarios.length !== 1) {
    throw new Error("VERIFY_RUN_ID 复核模式一次只能指定一个场景");
  }

  console.log(`VibeU 场景验证 · ${scenarios.map((scenario) => scenario.id).join("、")} · ${MODEL}`);
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    results.push(result);
    console.log(
      `${result.ok ? "✓" : "✗"} ${scenario.id} ${(result.wallMs / 1000).toFixed(0)}s ` +
        (result.ok
          ? `${result.dispatches}轮 · ${result.qaRounds}轮QA · ${(result.tokens ?? 0) / 1000}k tok · $${(result.costUsd ?? 0).toFixed(4)}`
          : `[${result.stage}] ${result.reason}`),
    );
  }

  mkdirSync("tests/results", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = `tests/results/${stamp}.json`;
  writeFileSync(
    file,
    JSON.stringify(
      {
        model: MODEL,
        baseUrl: BASE,
        at: new Date().toISOString(),
        passed: results.filter((result) => result.ok).length,
        total: results.length,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`结果：${file}`);
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}

void main();
