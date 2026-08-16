"use client";

/**
 * 生成物预览 —— 直接嵌已构建的候选版本。
 *
 * 不用浏览器内打包器:代码在服务端就已经用 esbuild 编译过了,
 * 这里嵌的和用户拿到链接打开的是**同一个东西**,不存在预览与线上两套渲染路径。
 */

import { useMemo } from "react";

export function Preview({ runId, version }: { runId: string; version: number }) {
  // version 变化时换 src,强制重新加载新构建
  const src = useMemo(() => `/a/${runId}?embed&v=${version}`, [runId, version]);
  return (
    <iframe
      key={src}
      src={src}
      title="生成物预览"
      className="size-full rounded-lg border border-ink-800 bg-white"
      sandbox="allow-scripts allow-same-origin allow-forms"
    />
  );
}
