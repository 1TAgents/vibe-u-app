/**
 * 事件模型 —— Glassbox 的地基。
 *
 * 设计原则:整场生成过程中发生的每一件事都必须是一条可序列化事件,
 * 且事件流是唯一真相源。UI 只是事件流的投影,回放只是重放同一串事件。
 * 这样"实时观看"和"事后回放"共用一套渲染逻辑,不存在两份实现漂移的问题。
 */

export type NodeId =
  | "pm"
  /** 交付后的需求统一先由产品经理判断影响范围 */
  | "intake"
  /** 需求改变产品定义时,由产品经理修订现有 PRD */
  | "pmChange"
  | "architect"
  /** 需求改变数据模型或页面结构时,由架构师修订设计 */
  | "architectChange"
  /** 把产品与页面结构翻译成视觉语言和页面构图 */
  | "designer"
  | "engineer"
  | "verify"
  | "fix"
  /** 生成完之后,按用户对话要求做的增量修改 */
  | "iterate"
  /** 写验收测试的测试工程师 */
  | "qa"
  /** 验收失败后接住 Vera 报告、归因并分配责任的产品负责人 */
  | "triage"
  /** 验收反复失败后被拉进来复审设计的架构师 */
  | "review"
  /** 交付验收 —— 需求提出人对最终产物的可交付判断 */
  | "accept"
  | "done";

export type ArtifactKind = "prd" | "design" | "visual" | "files" | "tests";

export type ChangeKind = "visual" | "copy" | "bug" | "feature" | "architecture";
export type ChangeQaMode = "smoke" | "regenerate";

/** 产品经理对一条交付后需求的影响评估。 */
export interface ChangeAssessment {
  kind: ChangeKind;
  prdImpact: boolean;
  designImpact: boolean;
  qaMode: ChangeQaMode;
  reason: string;
}

/**
 * QA 失败根因的归因类别 —— Emma 决定谁该为这轮失败负责。
 * 这是产品规则:Vera 只报告与复测,不承担需求路由权;路由权在 Emma。
 */
export type QaCause = "visual" | "implementation" | "architecture" | "requirements";

/** Emma 对一轮 QA 失败报告的归因与分配结论。 */
export interface QaTriage {
  cause: QaCause;
  /** 需要 Emma 修订 PRD(验收口径含糊、需求冲突或不可实现) */
  prdImpact: boolean;
  /** 需要 Maya 修订视觉方案(视觉/信息层级/交互理解) */
  visualImpact: boolean;
  /** 需要 Bob 修订设计(数据模型/状态流转/跨模块边界) */
  designImpact: boolean;
  /** Emma 归因的一句话说明 */
  reason: string;
  /** 该归因覆盖的失败用例 */
  cases: string[];
  /** 确定性路由出的第一责任人 */
  assignee: "emma" | "maya" | "bob" | "alex";
  /** 本轮需要执行的角色节点序列(去重、按协作顺序) */
  route: NodeId[];
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
}

export const EMPTY_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** 生成物文件 */
export interface GeneratedFile {
  path: string;
  content: string;
}

/** 校验发现的问题 */
export interface VerifyIssue {
  /** compile = Sandpack 打包失败;runtime = 运行时抛错;blank = 渲染成功但页面空白;static = 源码级静态审计发现 */
  kind: "compile" | "runtime" | "blank" | "static";
  message: string;
  path?: string;
}

/**
 * 验收用例执行步骤的可序列化快照 —— 只保留定位/动作所需字段。
 *
 * 独立定义在事件模型里(不依赖 testrunner),让压力覆盖审计能拿到「用例到底做了什么」,
 * 而不只是用例名。qa.result 里每个 case 的 steps 为可选:历史事件没有,回放不受影响。
 */
export interface QaStepSnapshot {
  action:
    | "click"
    | "fill"
    | "expectText"
    | "expectNoText"
    | "advanceTime"
    | "expectTextWithin"
    | "expectNoTextWithin"
    | "expectValue"
    | "expectNumberWithin"
    | "expectAttribute"
    | "expectNoAttribute";
  target?: string;
  text?: string;
  value?: string;
  /** expectAttribute / expectNoAttribute 断言的语义状态属性名(如 data-state / aria-invalid) */
  attr?: string;
  /** advanceTime 推进的毫秒数 —— 计时/轮询终态的验证证据 */
  ms?: number;
}

export type RunEvent =
  | { type: "run.started"; prompt: string; model: string; label?: string }
  /** 用户在对话框里提的修改要求 —— 第二轮之后的每一次迭代都从这里开始 */
  | { type: "chat.user"; text: string; turn: number }
  /** Emma 接单后的路由结论 —— 角色分工必须作为事件被审计和回放 */
  | { type: "chat.routed"; turn: number; assessment: ChangeAssessment }
  /** 一轮迭代收尾,附上工程师对本次改动的说明 */
  | { type: "chat.done"; turn: number; summary: string; changed: string[] }
  | { type: "node.started"; node: NodeId; role: string; model: string }
  /** 推理模型的思考链增量 —— 这是把 agent 从黑盒变成玻璃盒的关键 */
  | { type: "node.reasoning.delta"; node: NodeId; text: string }
  | { type: "node.content.delta"; node: NodeId; text: string }
  | {
      type: "node.finished";
      node: NodeId;
      usage: Usage;
      durationMs: number;
      /** 真实发给模型的 prompt,前端可展开审计 */
      prompt: string;
      /** 模型原始输出,未经解析 */
      raw: string;
    }
  | { type: "node.failed"; node: NodeId; error: string; usage?: Usage }
  /** 请求层瞬时故障重试 —— 网络抖动是必然事件,但不该悄悄发生 */
  | { type: "node.retry"; node: NodeId; attempt: number; waitMs: number }
  /**
   * 推理模式降级 —— 结构化角色一次出现「有 reasoning 但正文为空/推理空转」后,
   * 下一次重试必须 thinking=disabled(普通网络/解析错误保留原策略)。
   * 记录降级原因与切换后的 thinking 模式,fold/UI/runner 可审计。
   */
  | {
      type: "node.thinking_degrade";
      node: NodeId;
      /** 降级后生效的第几次尝试 */
      attempt: number;
      /** 降级原因:spiral = 思考超阈值仍无正文;empty = 流正常结束但正文为空 */
      reason: "spiral" | "empty";
      /** 降级前的 thinking 模式(default = 请求体未显式传,网关默认 enabled) */
      from: "enabled" | "disabled" | "default";
      /** 降级后的 thinking 模式 */
      to: "disabled";
      /** 已被掐断/废弃尝试累计消耗的 token 与成本 —— 成本面板不丢 */
      wastedTokens?: number;
      wastedCostUsd?: number;
    }
  /**
   * 模型的结构化产物没通过解析,已把解析错误回喂给它重写。
   * 每次解析失败都留痕 —— 审计能看出某个角色被修正了几次、因为什么错。
   */
  | { type: "node.parse_retry"; node: NodeId; attempt: number; reason: string }
  /**
   * 旧事件名(与 node.parse_retry 同构)。历史运行 JSONL 已持久化该事件,
   * 不能从 union 里删 —— 删除会导致旧 run 回放丢解析失败。fold 与新事件走同一分支;
   * 新写入一律用 node.parse_retry。
   */
  | { type: "artifact.rejected"; node: NodeId; attempt: number; reason: string }
  | { type: "artifact"; kind: ArtifactKind; data: unknown }
  | { type: "hitl.awaiting"; node: NodeId; kind: ArtifactKind }
  | {
      type: "hitl.resolved";
      node: NodeId;
      decision: "approved" | "rejected";
      /** 用户是否直接改写了产物(接管),而不只是点了批准 */
      edited: boolean;
    }
  /** 服务端构建 —— 编译错误在这里就被拦住,不会流到用户浏览器 */
  | { type: "build.started"; attempt: number }
  | {
      type: "build.result";
      attempt: number;
      ok: boolean;
      /** 构建成功时的产物体积(字节) */
      bytes?: number;
      durationMs: number;
      errors: string[];
    }
  /** 功能级验收测试 —— 不只看渲染,而是走一遍真实操作 */
  | { type: "qa.started"; attempt: number }
  | {
      type: "qa.result";
      attempt: number;
      passed: number;
      failed: number;
      durationMs: number;
      cases: {
        name: string;
        /** 该用例声明覆盖的 PRD P0 功能名；历史事件没有，保持 optional。 */
        covers?: string[];
        ok: boolean;
        reason?: string;
        steps?: QaStepSnapshot[];
      }[];
    }
  /**
   * Vera 报告失败后,Emma 的归因与分配 —— 组织闭环的审计点。
   * Vera 只报告,Emma 判断根因并决定由谁处理,再由对应角色修订、Alex 实现、Vera 回归。
   */
  | { type: "qa.triage"; attempt: number; triage: QaTriage }
  /**
   * Vera 产出的验收用例没覆盖 PRD P0 功能或场景难点 —— 覆盖门在 runTests **之前**拦截。
   * 这不是产品执行失败,是测试计划没测到重点:把缺失的难点语义回喂 Vera,
   * 让她在同一 attempt 内重写测试计划,有限次数内覆盖合格才真正执行。
   */
  | {
      type: "qa.coverage_retry";
      attempt: number;
      /** 本 attempt 内第几次覆盖修订(1..MAX_COVERAGE_RETRIES) */
      round: number;
      /** 缺覆盖的难点语义(正则原文 / 结构要求文案) —— 正是要回喂给 Vera 的证据 */
      missing: string[];
    }
  /**
   * 写测试计划前的界面探查 —— 把应用真的渲染一次,采下 Vera 实际能定位到的控件名。
   *
   * 为什么要单独发一条事件:她只看源码时会**猜**控件叫什么,而源码里有某个
   * 字符串不代表界面上定位得到(它可能在还没打开的弹窗里)。探查成功与否
   * 直接决定她是在照着看还是在猜,所以必须留痕 —— 悄悄降级而时间轴上什么都
   * 不显示,正是这个项目一直在反对的那种失败:出了问题没法定位,
   * 因为根本看不见它发生过。
   */
  | {
      type: "screen.probed";
      ok: boolean;
      /** 探到几层界面:首屏 / 点开新建之后 / 造出一条记录之后 */
      layers: number;
      clickables: string[];
      inputs: string[];
      regions: string[];
      /** 打开第 2 层用的入口控件名 */
      openedVia?: string;
      /** 造出记录用的操作描述 */
      createdVia?: string;
    }
  /**
   * 责任升级 —— 自动修复预算耗尽后交给人。
   * 触发条件是客观事实(预算耗尽),不是让模型判断该找谁。
   */
  | {
      type: "escalated";
      to: "architect" | "human" | "platform";
      attempt: number;
      reason: string;
      cases: string[];
    }
  /**
   * 同一失败签名在修复后原样复现 —— 修复未生效或疑似测试基础设施异常。
   * 审计后终止自动派单,交给平台维护审查,不再让 Emma 反复改派给 Alex/Bob 烧 token。
   *
   * 触发阈值是累计**第三次**相同签名复现:第一次是普通修复,第二次记录「修复未生效」
   * 并由 Emma 保持原责任人再修一次,第三次仍原样复现才升级平台。
   */
  | {
      type: "qa.infrastructure_suspected";
      attempt: number;
      /** 原样复现的失败用例 */
      cases: string[];
      /** 归一化的失败签名,证据本身可审计 */
      signature: string;
    }
  /**
   * 同一失败签名第二次原样复现 —— 修复未生效。
   * 不立即判基础设施:Emma 保持原责任人再修一次,第三次仍复现才升级平台。
   */
  | {
      type: "qa.fix_ineffective";
      attempt: number;
      /** 原样复现的失败用例 */
      cases: string[];
      /** 归一化的失败签名,证据本身可审计 */
      signature: string;
    }
  /**
   * 静态质量审计(计时器生命周期)发现源码级问题 —— 构建后、Vera 验收前,直接派 Alex 修复。
   */
  | {
      type: "audit.failed";
      attempt: number;
      /** 第几轮静态修复(1..MAX_AUDIT_ATTEMPTS) */
      round: number;
      /** 审计给出的问题清单 —— 修复时的 issues 来源 */
      reasons: string[];
      /** 参与了审计的文件路径 */
      files: string[];
    }
  /**
   * 静态审计在修复次数上限内仍未通过 —— 记录后继续交 Vera 走运行验证,
   * runner 的 timerSafety 硬门是第二道防线,不会因此放过不安全产物。
   */
  | {
      type: "audit.exhausted";
      attempt: number;
      reasons: string[];
    }
  /**
   * 产品负责人交付验收 —— Vera 验「功能是否按 PRD 工作」,Emma 验「能不能交出去」。
   * 后者包含判断:使用习惯、视觉是否匹配目标人群。两件事不能合并,
   * 用例全绿但界面难用的产品在真实公司里同样不能交付。
   */
  | { type: "accept.started"; attempt: number }
  | {
      type: "accept.result";
      attempt: number;
      accepted: boolean;
      /** 三个维度分别判定,避免用一句「整体不错」糊过去 */
      dimensions: {
        functional: { ok: boolean; note: string };
        usability: { ok: boolean; note: string };
        visual: { ok: boolean; note: string };
      };
      /** 打回时的具体问题与期望 —— 直接作为 Maya/Alex 的返工依据 */
      issues: { dimension: "usability" | "visual"; problem: string; expectation: string }[];
      /** 采证阶段确定的客观缺陷(无标签控件等),不经模型判断 */
      hardIssues: string[];
      summary: string;
    }
  | { type: "verify.started"; attempt: number }
  | { type: "verify.result"; attempt: number; ok: boolean; issues: VerifyIssue[] }
  | { type: "fix.started"; attempt: number; issues: VerifyIssue[] }
  | {
      type: "fix.diff";
      attempt: number;
      changed: { path: string; before: string; after: string }[];
    }
  | { type: "run.finished"; status: "succeeded" | "failed"; totals: Usage }
  | { type: "run.aborted"; reason: string };

/** 落库/传输时包裹的信封 */
export interface Envelope<T = RunEvent> {
  runId: string;
  seq: number;
  ts: number;
  event: T;
}

export type RunStatus =
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "aborted";
