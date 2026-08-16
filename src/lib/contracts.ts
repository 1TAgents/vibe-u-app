/**
 * 产物契约 —— 角色产出什么、事件流记录什么,两边共用这一份定义。
 *
 * 为什么单独成一个模块:这些 schema 原先和提示词写在一起,导致事件折叠(L0)
 * 反过来 import 角色模块(L2) —— 分层倒过来了。契约是双方共享的第三方,
 * 谁都不该拥有它。
 *
 * schema 用 zod 而不是裸类型,因为它同时承担运行期校验:
 * 模型输出的 JSON 必须过一遍才算数,解析失败会把错误原文回喂让它重写。
 */

import { z } from "zod";

export const PrdSchema = z.object({
  title: z.string(),
  oneLiner: z.string(),
  targetUsers: z.array(z.string()).min(1),
  coreFeatures: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        priority: z.enum(["P0", "P1", "P2"]).default("P0"),
      }),
    )
    .min(1),
  userFlow: z.array(z.string()).min(1),
  nonGoals: z.array(z.string()).default([]),
});
export type Prd = z.infer<typeof PrdSchema>;

export const DesignSchema = z.object({
  dataModel: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        fields: z.array(
          z.object({
            name: z.string(),
            type: z.string(),
            required: z.boolean().default(false),
            description: z.string().default(""),
          }),
        ),
      }),
    )
    .min(1),
  pages: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        components: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  notes: z.string().default(""),
});
export type Design = z.infer<typeof DesignSchema>;

/** 产品设计师的视觉方案。独立成产物，避免技术设计直接落成通用后台模板。 */
export const VisualDesignSchema = z.object({
  concept: z.string().min(1),
  tone: z.string().min(1),
  experience: z.object({
    primaryJourney: z.array(z.string()).min(2).max(8),
    navigation: z.string().min(1),
    keyStates: z.array(z.string()).min(3).max(8),
  }),
  layout: z.object({
    shell: z.string().min(1),
    hierarchy: z.array(z.string()).min(2).max(6),
    responsive: z.string().min(1),
  }),
  palette: z.object({
    canvas: z.string().min(1),
    surface: z.string().min(1),
    primary: z.string().min(1),
    accent: z.string().min(1),
    text: z.string().min(1),
  }),
  typography: z.object({
    display: z.string().min(1),
    body: z.string().min(1),
    numeric: z.string().min(1),
  }),
  signatureElements: z.array(z.string()).min(2).max(5),
  componentTreatments: z
    .array(
      z.object({
        component: z.string().min(1),
        treatment: z.string().min(1),
      }),
    )
    .min(3)
    .max(8),
  avoid: z.array(z.string()).min(2).max(8),
});
export type VisualDesign = z.infer<typeof VisualDesignSchema>;

export const TestCaseSchema = z.object({
  cases: z
    .array(
      z.object({
        name: z.string(),
        /** 必须逐字引用 PRD P0 功能名；一条主流程可以覆盖多个功能。 */
        covers: z.array(z.string()).min(1),
        steps: z
          .array(
            z.union([
              z.object({ action: z.literal("click"), target: z.string() }),
              z.object({ action: z.literal("fill"), target: z.string(), value: z.string() }),
              z.object({ action: z.literal("expectText"), text: z.string() }),
              z.object({ action: z.literal("expectNoText"), text: z.string() }),
              z.object({ action: z.literal("advanceTime"), ms: z.number().int().positive() }),
              z.object({ action: z.literal("expectTextWithin"), target: z.string(), text: z.string() }),
              z.object({ action: z.literal("expectNoTextWithin"), target: z.string(), text: z.string() }),
              z.object({ action: z.literal("expectValue"), target: z.string(), value: z.string() }),
              z.object({ action: z.literal("expectNumberWithin"), target: z.string(), value: z.string() }),
              z.object({ action: z.literal("expectAttribute"), target: z.string(), attr: z.string(), value: z.string() }),
              z.object({ action: z.literal("expectNoAttribute"), target: z.string(), attr: z.string(), value: z.string() }),
            ]),
          )
          .min(1),
      }),
    )
    .min(1)
    .max(4),
});
