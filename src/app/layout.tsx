import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VibeU · 可审计的 AI 产品团队",
  description:
    "用自然语言生成可运行、可持久化、可分享的全栈应用 —— 并且整个过程透明、可审计。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    /*
     * suppressHydrationWarning 只加在 html / body 这两个根元素上。
     *
     * 大量浏览器扩展会在 React 接管之前往根元素注入属性
     * (实测遇到过某扩展写入 data-yiwx-installed="true"),
     * 服务端渲染的 HTML 里当然没有这些属性,hydration 因此对不上,
     * 用户会看到一个与自己代码毫无关系的红色报错。
     *
     * 这不是在掩盖问题:React 官方就是为这个场景提供的该属性,
     * 且它只抑制这一层的属性差异,组件树内部真正的 hydration 不一致照常报错。
     */
    <html lang="zh-CN" className="h-full" suppressHydrationWarning>
      <body className="min-h-full" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
