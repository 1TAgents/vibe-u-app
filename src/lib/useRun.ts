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
import type { Envelope, RunEvent, RunStatus, VerifyIssue } from "./events";
import { applyEvent, emptyState, resetState, type RunState } from "./fold";
import type { QueuedChange } from "./store";

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
  const [queuedChanges, setQueuedChanges] = useState<QueuedChange[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const processingQueueRef = useRef(false);
  const queuePausedRef = useRef(false);
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
        if ((e as Error).name === "AbortError") return false;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("failed");
        return false;
      }
      if (state.aborted) {
        setPhase("failed");
        setError(state.aborted);
        return false;
      }
      onOk();
      return true;
    },
    [consume, state],
  );

  const refreshQueue = useCallback(async (id = runIdRef.current) => {
    if (!id) return [];
    const res = await fetch(`/api/run/${id}/queue`);
    if (!res.ok) return [];
    const data = (await res.json()) as { queue?: QueuedChange[] };
    const queue = data.queue ?? [];
    setQueuedChanges(queue);
    return queue;
  }, []);

  const start = useCallback(
    async (prompt: string, model?: string, opts?: { autoApprove?: boolean }) => {
      resetState(state);
      setQueuedChanges([]);
      queuePausedRef.current = false;
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

  /** 真正启动一轮需求变更；排队项只有走到这里才进入正式事件流。 */
  const executeMessage = useCallback(
    async (text: string, queueId?: string) => {
      const id = runIdRef.current;
      if (!id || !text.trim()) return false;
      setError(null);
      setPhase("generating");
      // 改完照样要过运行时校验 ——「用户让我改的」不构成跳过验证的理由
      const ok = await runStream(`/api/run/${id}/chat`, { text, queueId }, syncPhase);
      await refreshQueue(id);
      return ok;
    },
    [refreshQueue, runStream, syncPhase],
  );

  /**
   * 老板始终可以说话：空闲时立即开新一轮，执行中或已有排队项时按 FIFO 持久化。
   * 当前轮不会被半途改写，下一轮也不会因为刷新页面而消失。
   */
  const sendMessage = useCallback(
    async (text: string) => {
      const id = runIdRef.current;
      const value = text.trim();
      if (!id || !value) return;
      const mustQueue =
        phase === "generating" ||
        phase === "fixing" ||
        phase === "verifying" ||
        processingQueueRef.current ||
        queuedChanges.length > 0;

      if (!mustQueue) {
        queuePausedRef.current = false;
        await executeMessage(value);
        return;
      }

      const res = await fetch(`/api/run/${id}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: value }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        item?: QueuedChange;
        error?: string;
      };
      if (!res.ok || !data.item) {
        setError(data.error || `需求排队失败 (${res.status})`);
        return;
      }
      setError(null);
      setQueuedChanges((current) => [...current, data.item!]);
    },
    [executeMessage, phase, queuedChanges.length],
  );

  /** 撤回尚未进入正式工作流的排队要求。服务端会再次校验状态，避免多端竞态误删。 */
  const deleteQueuedChange = useCallback(
    async (queueId: string) => {
      const id = runIdRef.current;
      if (!id) return false;

      const item = queuedChanges.find((change) => change.id === queueId);
      if (!item || item.status !== "pending") return false;

      const res = await fetch(
        `/api/run/${id}/queue?id=${encodeURIComponent(queueId)}`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || `删除排队任务失败 (${res.status})`);
        await refreshQueue(id);
        return false;
      }

      setError(null);
      setQueuedChanges((current) =>
        current.filter((change) => change.id !== queueId),
      );
      return true;
    },
    [queuedChanges, refreshQueue],
  );

  /** 当前任务周期到达安全终态后，自动按顺序接下一条要求。 */
  useEffect(() => {
    if (
      queuePausedRef.current ||
      processingQueueRef.current ||
      queuedChanges.length === 0 ||
      state.files.length === 0 ||
      (phase !== "succeeded" && phase !== "failed")
    ) {
      return;
    }

    const next = queuedChanges[0];
    processingQueueRef.current = true;
    setQueuedChanges((current) => current.filter((item) => item.id !== next.id));
    void executeMessage(next.text, next.id)
      .then((ok) => {
        if (!ok) queuePausedRef.current = true;
      })
      .finally(() => {
        processingQueueRef.current = false;
      });
  }, [executeMessage, phase, queuedChanges, state.files.length]);

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
      const data = (await res.json()) as {
        run: { status: RunStatus };
        events: Envelope<RunEvent>[];
      };
      resetState(state);
      for (const env of data.events) applyEvent(state, env);
      runIdRef.current = id;
      setRunId(id);
      await refreshQueue(id);
      flushNow();

      // 数据库里的 run.status 是本次运行的最终运营状态。异常断流等情况下，
      // 事件流可能来不及追加 run.finished；若只靠 fold 推导，历史失败项目会被
      // 错画成“生成中”，群聊输入也会永久禁用。载入历史时以落库状态兜底，
      // 同时仍保留事件流里的全部失败现场与已有产物，允许用户继续提出修改。
      if (data.run.status === "succeeded") setPhase("succeeded");
      else if (data.run.status === "failed" || data.run.status === "aborted") setPhase("failed");
      else if (data.run.status === "awaiting_approval") setPhase("awaiting_approval");
      else syncPhase();
    },
    [flushNow, refreshQueue, syncPhase, state],
  );

  return {
    runId,
    state,
    phase,
    version,
    error,
    queuedChanges,
    start,
    approve,
    reject,
    reportVerify,
    sendMessage,
    deleteQueuedChange,
    abort,
    load,
  };
}
