"use client";

/**
 * 运行控制器 —— 前端唯一的状态入口。
 *
 * 它只做两件事:把 SSE 事件流 fold 成 RunState,以及在合适的时机推进阶段。
 * 所有 UI 都从同一个 RunState 渲染,回放页也用同一份 fold ——
 * 实时和回放不可能画出不一样的东西,这是结构保证而不是纪律保证。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Prd } from "./roles";
import type { Envelope, RunEvent, VerifyIssue } from "./events";
import { applyEvent, emptyState, resetState, type RunState } from "./fold";

export const MAX_FIX_ATTEMPTS = 3;

export type Phase =
  | "idle"
  | "generating"
  | "awaiting_approval"
  | "verifying"
  | "fixing"
  | "succeeded"
  | "failed";

export function useRun() {
  /**
   * 状态对象在整个 hook 生命周期内身份不变,事件是**就地**折叠进去的。
   * 一次生成会产生数千条 token 级事件,每条都做不可变拷贝会让 UI 掉帧;
   * 重渲染改由 version 计数驱动。
   */
  const [state] = useState<RunState>(emptyState);
  const runIdRef = useRef<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dirtyRef = useRef(false);

  /**
   * 渲染节流:一次生成会产生数千条 token 级事件。
   * 逐条 setState 会让 React 调度淹没主线程,思考链滚起来会卡顿。
   * 改成 50ms 心跳合并刷新,肉眼仍是流式,但帧率稳定。
   */
  useEffect(() => {
    const t = setInterval(() => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        setVersion((v) => v + 1);
      }
    }, 50);
    return () => clearInterval(t);
  }, []);

  const flushNow = useCallback(() => {
    dirtyRef.current = false;
    setVersion((v) => v + 1);
  }, []);

  /** 根据 fold 后的状态推导阶段,避免用一堆布尔量互相打架 */
  const syncPhase = useCallback(() => {
    const s = state;
    if (s.aborted) return setPhase("failed");
    if (s.finished === "succeeded") return setPhase("succeeded");
    if (s.finished === "failed") return setPhase("failed");
    if (s.awaiting === "approval") return setPhase("awaiting_approval");
    if (s.awaiting === "verify") return setPhase("verifying");
    return setPhase("generating");
  }, [state]);

  /** 消费一条 SSE 流直到服务端关闭 */
  const consume = useCallback(
    async (res: Response) => {
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(text.slice(0, 300) || `请求失败 ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let env: Envelope<RunEvent>;
          try {
            env = JSON.parse(payload) as Envelope<RunEvent>;
          } catch {
            continue; // 半帧或心跳
          }
          if (runIdRef.current !== env.runId) {
            runIdRef.current = env.runId;
            setRunId(env.runId);
          }
          applyEvent(state, env);
          dirtyRef.current = true;
        }
      }
      flushNow();
    },
    [flushNow, state],
  );

  const runStream = useCallback(
    async (url: string, body: unknown, onOk: () => void) => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        await consume(res);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("failed");
        return;
      }
      if (state.aborted) {
        setPhase("failed");
        setError(state.aborted);
        return;
      }
      onOk();
    },
    [consume, state],
  );

  const start = useCallback(
    async (prompt: string, model?: string, opts?: { autoApprove?: boolean }) => {
      resetState(state);
      runIdRef.current = null;
      setRunId(null);
      setError(null);
      setPhase("generating");
      flushNow();
      await runStream(
        "/api/run",
        { prompt, model, autoApprove: opts?.autoApprove },
        // QA 可能在代码产出后终止流程,必须从事件真相推导状态。
        syncPhase,
      );
    },
    [runStream, syncPhase, flushNow, state],
  );

  const approve = useCallback(
    async (prd: Prd) => {
      const id = runIdRef.current;
      if (!id) return;
      setPhase("generating");
      await runStream(
        `/api/run/${id}/resume`,
        { decision: "approved", prd },
        syncPhase,
      );
    },
    [runStream, syncPhase],
  );

  const reject = useCallback(async () => {
    const id = runIdRef.current;
    if (!id) return;
    await runStream(`/api/run/${id}/resume`, { decision: "rejected" }, () =>
      setPhase("failed"),
    );
  }, [runStream]);

  /** 沙箱把真实运行结果报回来:通过则收工,不通过则回喂修复 */
  const reportVerify = useCallback(
    async (ok: boolean, issues: VerifyIssue[]) => {
      const id = runIdRef.current;
      if (!id) return;
      const attempt = state.attempt;

      const res = await fetch(`/api/run/${id}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attempt, ok, issues }),
      });
      const data = (await res.json()) as { events?: Envelope<RunEvent>[] };
      for (const env of data.events ?? []) applyEvent(state, env);
      flushNow();

      if (ok) return setPhase("succeeded");
      if (attempt > MAX_FIX_ATTEMPTS) {
        setPhase("failed");
        setError(`连续 ${MAX_FIX_ATTEMPTS} 次修复仍未通过运行时校验`);
        return;
      }

      setPhase("fixing");
      await runStream(`/api/run/${id}/fix`, { issues }, () => setPhase("verifying"));
    },
    [runStream, flushNow, state],
  );

  /** 生成完之后,按对话要求改一版 */
  const sendMessage = useCallback(
    async (text: string) => {
      const id = runIdRef.current;
      if (!id || !text.trim()) return;
      setError(null);
      setPhase("generating");
      // 改完照样要过运行时校验 ——「用户让我改的」不构成跳过验证的理由
      await runStream(`/api/run/${id}/chat`, { text }, syncPhase);
    },
    [runStream, syncPhase],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setPhase("failed");
    setError("已由用户中断");
  }, []);

  /** 载入一次历史运行(回放) */
  const load = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/run/${id}/events`);
      if (!res.ok) {
        setError("找不到这次运行");
        return;
      }
      const data = (await res.json()) as { events: Envelope<RunEvent>[] };
      resetState(state);
      for (const env of data.events) applyEvent(state, env);
      runIdRef.current = id;
      setRunId(id);
      flushNow();
      syncPhase();
    },
    [flushNow, syncPhase, state],
  );

  return {
    runId,
    state,
    phase,
    version,
    error,
    start,
    approve,
    reject,
    reportVerify,
    sendMessage,
    abort,
    load,
  };
}
