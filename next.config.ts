import type { NextConfig } from "next";

/**
 * 生成器在 Serverless 函数里运行，需要把构建工具的 JS 包与当前 Linux 平台的
 * 可选原生包一起追踪。只 externalize 主包但不显式 include 平台包，会在 Vercel
 * 运行时报 lightningcss.linux-x64-gnu.node / esbuild binary 找不到。
 */
const generatedAppRuntime = [
  "./node_modules/react/**/*",
  "./node_modules/react-dom/**/*",
  "./node_modules/scheduler/**/*",
  "./node_modules/lucide-react/**/*",
  "./node_modules/esbuild/**/*",
  "./node_modules/@esbuild/**/*",
  "./node_modules/@tailwindcss/node/**/*",
  "./node_modules/@tailwindcss/oxide/**/*",
  "./node_modules/@tailwindcss/oxide-*/**/*",
  // @tailwindcss/node 在运行期解析 `@import "tailwindcss"`，静态追踪只能看见
  // package.json，看不见 exports 指向的实际 CSS 文件；必须把整个包带进函数。
  "./node_modules/tailwindcss/**/*",
  "./node_modules/lightningcss/**/*",
  "./node_modules/lightningcss-*/**/*",
];

const nextConfig: NextConfig = {
  /**
   * 关掉严格模式是被 Sandpack 逼的,不是图省事。
   *
   * 严格模式在开发环境会把 effect 跑成 挂载→卸载→再挂载。Sandpack 在挂载时创建
   * 打包器 iframe 并等待跨源握手,卸载时销毁 client;第二次挂载复用的是**同一个
   * iframe DOM 节点**,src 没有变化因而不会触发新的 load 事件,握手消息永远等不到,
   * 预览就永远停在加载动画上 —— 而且不报任何错。
   *
   * 生产构建没有这个双挂载,所以这只影响开发体验。但开发时预览是整条自愈校验链路的
   * 输入,不能带病工作。代码里另有 BundlerWatchdog 做兜底重试,双保险。
   */
  reactStrictMode: false,

  /**
   * 关掉开发期的浮动指示器。
   *
   * 它默认悬在左下角,正好压住工作区的对话输入框。四个可选位置各自都会
   * 撞到东西:左下是输入框、右下是生成物自己的悬浮按钮、上方是导航与操作按钮。
   * 而它提供的只是当前路由类型这类调试信息 —— 关掉之后编译错误与运行时
   * 错误照常会报(官方文档明确说明),等于没有损失。
   *
   * 路由是静态还是动态,`next build` 的输出里看得更清楚。
   */
  devIndicators: false,

  /**
   * 构建工具链必须排除在打包之外 —— 它们都带原生二进制。
   *
   * esbuild 是通过子进程调用的原生可执行文件,Tailwind v4 依赖 oxide(扫描器)
   * 与 lightningcss(CSS 处理),两者都是 .node 原生模块。
   *
   * 打包器会顺着 JS 里的 require 去读这些二进制、把它们当源码解析,
   * 报出来的错极具误导性(「failed to convert rope into string」),
   * 而且被归因到**传递引用它们的路由文件**上,看起来像是那个路由写坏了。
   * 我为此在错误的文件上排查了一轮。
   *
   * 排除之后走原生 require,二进制留在 node_modules 里由运行时直接调用。
   */
  serverExternalPackages: [
    "esbuild",
    "@tailwindcss/node",
    "@tailwindcss/oxide",
    "lightningcss",
  ],

  // 动态 require.resolve 无法被静态追踪器推断；明确把构建器需要的浏览器运行时
  // 收进 /api/run 函数。scheduler 是 react-dom 的运行时依赖。
  outputFileTracingIncludes: {
    "/api/run": generatedAppRuntime,
    "/api/run/[runId]/chat": generatedAppRuntime,
    "/api/run/[runId]/resume": generatedAppRuntime,
    "/a/[runId]": generatedAppRuntime,
  },
};

export default nextConfig;
