/**
 * 事件出口 —— 所有角色、所有门,都只能通过它往事件流里写。
 *
 * 为什么单独成一个模块:它原先长在编排层里,于是 SSE 基础设施反过来
 * import 编排层 —— 分层倒过来了。它其实只依赖事件模型与存储,
 * 属于 L0 的一部分,谁产生事件都用同一个出口。
 *
 * 两个刻意的行为:
 *   写盘攒批(200 条或 400ms) —— 一次生成会产生数千条 token 级事件,
 *     逐条落盘会把磁盘打满;但 write 回调是**立即**调用的,
 *     所以前端看到的仍然是实时流,攒批只影响持久化。
 *   用量随事件累计 —— 停在审批门或中途断掉的生成,历史里也要显示真实花费,
 *     显示成 0 是不诚实的。
 */

import {
  addUsage,
  EMPTY_USAGE,
  type Envelope,
  type RunEvent,
  type Usage,
} from "./events";
import { getStore } from "./store";

/** 攒够这么多条就立刻落盘,不等计时器 */
const FLUSH_AT = 200;
/** 没攒够也最多等这么久,免得末尾几条一直悬着 */
const FLUSH_AFTER_MS = 400;

export class EventSink {
  private seq = 0;
  private pending: Envelope<RunEvent>[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private usage: Usage = { ...EMPTY_USAGE };

  constructor(
    private runId: string,
    private write: (env: Envelope<RunEvent>) => void,
    startSeq = 0,
    /** 之前阶段已累计的用量,继续往上加 */
    priorUsage: Usage = EMPTY_USAGE,
  ) {
    this.seq = startSeq;
    this.usage = { ...priorUsage };
  }

  get nextSeq() {
    return this.seq;
  }

  get totals(): Usage {
    return this.usage;
  }

  get runIdValue(): string {
    return this.runId;
  }

  emit(event: RunEvent) {
    if (event.type === "node.finished") {
      this.usage = addUsage(this.usage, event.usage);
    }
    const env: Envelope<RunEvent> = {
      runId: this.runId,
      seq: this.seq++,
      ts: Date.now(),
      event,
    };
    // 先给前端,再攒批落盘 —— 实时性不为持久化让路
    this.write(env);
    this.pending.push(env);
    if (this.pending.length >= FLUSH_AT) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_AFTER_MS);
    }
    return env;
  }

  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    const store = getStore();
    await store.appendEvents(this.runId, batch);
    // 新运行不再写 token delta，每个批次只有少量业务事件；此时同步累计用量既便宜，
    // 又能留下 last-progress heartbeat。即使进程意外退出，项目列表也不会长期显示 $0。
    await store.updateRun(this.runId, { totals: this.usage });
  }
}
