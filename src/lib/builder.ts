/**
 * 服务端构建器 —— 把生成物编译成可以直接托管的静态产物。
 *
 * 这是「预览」和「产品」的分界线。
 *
 * 之前的做法是把源码丢给远程打包器,在**每一次页面访问时**现场编译:
 * 打开要等十几秒、依赖第三方服务存活、且是整个系统最不可靠的一环
 * (不得不为它写两级看门狗)。那不是上线,那是把编译推迟到了用户面前。
 *
 * 现在改成:生成完立刻在服务端 esbuild 编译一次,产物入库,之后每次访问
 * 都是直接吐静态资源。带来的不只是快:
 *   - 编译错误在**发布之前**就暴露,可以直接回喂给工程师,用户永远看不到坏页面
 *   - 生成物与平台同源,探针可以直接读 DOM,数据接口也不再需要跨源
 *   - React 与 Tailwind 都在构建期处理完,产物零外部依赖
 */

import * as esbuild from "esbuild";
import { compile as compileCss } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import path from "node:path";
import type { GeneratedFile } from "./events";

export interface BuildSuccess {
  ok: true;
  js: string;
  /** 只包含实际用到的工具类的 CSS */
  css: string;
  /** 压缩后字节数(js + css),用于在 UI 上展示产物体积 */
  bytes: number;
  durationMs: number;
  warnings: string[];
}

export interface BuildFailure {
  ok: false;
  durationMs: number;
  errors: { message: string; path?: string; line?: number }[];
}

export type BuildResult = BuildSuccess | BuildFailure;

/** 历史版本曾把 Tailwind 失败降级为空字符串并存库；空 CSS 不能当成可复用 bundle。 */
export function hasUsableGeneratedCss(css: string): boolean {
  return css.trim().length > 0;
}

const ENTRY = "/index.js";

// 只允许生成物使用平台明确提供的运行时包。实际文件路径必须在请求发生时动态解析：
// Vercel 会把 require.resolve 改写或裁掉，因此直接落到被 next.config 明确追踪的
// 标准包入口。项目锁定 React 版本后这些入口文件名稳定，同时仍由白名单限制范围。
const BUNDLED_RUNTIME_MODULES = new Map<string, string>([
  ["react", "react/index.js"],
  ["react/jsx-runtime", "react/jsx-runtime.js"],
  ["react/jsx-dev-runtime", "react/jsx-dev-runtime.js"],
  ["react-dom", "react-dom/index.js"],
  ["react-dom/client", "react-dom/client.js"],
  // 指向 ESM 入口，esbuild 才能把未使用的上千个图标 tree-shake 掉。
  // CJS 入口会把整包 Lucide 塞进每个生成物，一个简单待办也会平白增加约 650KB。
  ["lucide-react", "lucide-react/dist/esm/lucide-react.mjs"],
]);

/**
 * 虚拟文件系统插件。
 *
 * 生成物只存在于内存里(它来自 LLM,从没落过盘),所以 esbuild 的解析和读取
 * 都要接管:相对路径查内存,裸模块名(react 等)交还给 esbuild 走真实 node_modules。
 * 这样 React 会被真实打进产物,而不是指望运行时有个 CDN 在。
 */
function virtualFs(files: Map<string, string>): esbuild.Plugin {
  return {
    name: "glassbox-virtual-fs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // 只接管生成物自己的相对引用。
        // node_modules 内部也全是相对路径(react/index.js 里的 ./cjs/react.production.js),
        // 若不按导入者的命名空间区分,会把它们也拿去虚拟文件系统里找,必然找不到。
        if (args.importer && args.namespace !== "virtual") return undefined;

        // 自定义 namespace 中的裸模块在本地通常会被 esbuild 的默认解析兜住，
        // 但 Vercel Serverless 的 bundle/trace 环境不会稳定地走到那个兜底，
        // 最终表现为 react/jsx-runtime 或 react-dom/client 找不到。
        // 这里显式落到真实文件路径，后续 node_modules 内部引用再交回 file namespace。
        if (!args.path.startsWith(".") && !args.path.startsWith("/")) {
          const entry = BUNDLED_RUNTIME_MODULES.get(args.path);
          if (entry) return { path: path.join(process.cwd(), "node_modules", entry) };
          return {
            errors: [
              { text: `不允许或找不到依赖 ${args.path}；生成物只能导入 react 与 lucide-react` },
            ],
          };
        }
        const resolved = resolveVirtual(args.path, args.importer, files);
        if (!resolved) {
          return {
            errors: [
              {
                text:
                  `找不到模块 ${args.path}` +
                  (args.importer ? `(由 ${args.importer} 引入)` : "") +
                  `。可用文件:${[...files.keys()].join(", ")}`,
              },
            ],
          };
        }
        return { path: resolved, namespace: "virtual" };
      });

      build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => ({
        contents: files.get(args.path) ?? "",
        // 生成物统一是含 JSX 的 .js,必须显式指定 loader
        loader: args.path.endsWith(".css") ? "css" : "jsx",
        // 裸模块名(react 等)会以这个目录为起点去找 node_modules。
        // 必须是本项目根目录 —— 虚拟文件本身不在磁盘上,esbuild 无从推断。
        resolveDir: process.cwd(),
      }));
    },
  };
}

/** 把相对路径解析成虚拟文件系统里的绝对路径,并补齐省略的扩展名 */
function resolveVirtual(
  spec: string,
  importer: string | undefined,
  files: Map<string, string>,
): string | null {
  let base: string;
  if (spec.startsWith("/")) {
    base = spec;
  } else {
    const dir = importer ? importer.slice(0, importer.lastIndexOf("/")) : "";
    base = normalize(`${dir}/${spec}`);
  }

  const candidates = [
    base,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
  for (const c of candidates) {
    if (files.has(c)) return c;
  }
  return null;
}

/** 处理路径里的 . 与 .. 段 */
function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/**
 * 编译生成物。失败时返回结构化错误,直接可以回喂给工程师角色。
 */
export async function buildApp(files: GeneratedFile[]): Promise<BuildResult> {
  const started = Date.now();
  const map = new Map(files.map((f) => [f.path, f.content]));

  if (!map.has(ENTRY)) {
    return {
      ok: false,
      durationMs: 0,
      errors: [{ message: `缺少入口文件 ${ENTRY}` }],
    };
  }

  try {
    const result = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: ["es2020"],
      minify: true,
      jsx: "automatic",
      // React 走真实 node_modules 打进产物,运行时不依赖任何 CDN
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [virtualFs(map)],
      logLevel: "silent",
      // 生成物里出现 import 图片/字体属于误用,直接报错比静默产出坏产物好
      loader: { ".css": "css" },
    });

    const js = result.outputFiles?.[0]?.text ?? "";
    const css = await buildCss(files);
    return {
      ok: true,
      js,
      css,
      bytes: Buffer.byteLength(js, "utf8") + Buffer.byteLength(css, "utf8"),
      durationMs: Date.now() - started,
      warnings: result.warnings.map(formatMessage),
    };
  } catch (err) {
    const e = err as esbuild.BuildFailure;
    const errors = (e.errors ?? []).map((m) => ({
      message: formatMessage(m),
      path: m.location?.file,
      line: m.location?.line,
    }));
    return {
      ok: false,
      durationMs: Date.now() - started,
      errors: errors.length > 0 ? errors : [{ message: String(err).slice(0, 600) }],
    };
  }
}

/**
 * 服务端编译 Tailwind。
 *
 * 之前生成物是从 CDN 拉 Tailwind 的 Play 版本 —— 那是个**运行时 JIT 编译器**,
 * 三百多 KB,而且官方明确写着不要用于生产:每次打开页面都要下载编译器、
 * 扫一遍 DOM、再把样式注进去,首屏必然闪一下无样式内容。
 *
 * 改成构建期编译:扫描源码里出现的类名,只产出真正用到的规则。
 * 实测约 10KB,并且让生成物变成**零外部依赖** —— 断网也能跑,
 * 存成一个 HTML 文件双击就打开。
 *
 * 代价是类名必须在源码里**字面出现**:拼接出来的 `bg-${color}-500` 扫不到。
 * 这个约束已经写进工程师的 prompt(而且它本来就是 Tailwind 官方的推荐写法)。
 */
async function buildCss(files: GeneratedFile[]): Promise<string> {
  try {
    const scanner = new Scanner({});
    const candidates = scanner.scanFiles(
      files
        // 平台运行时里没有界面类名,不必参与扫描
        .filter((f) => !RUNTIME_SOURCES.has(f.path))
        .map((f) => ({ content: f.content, extension: "jsx" })),
    );

    const compiler = await compileCss(TAILWIND_ENTRY, {
      base: process.cwd(),
      onDependency: () => {},
    });
    const css = compiler.build(candidates);
    if (!hasUsableGeneratedCss(css)) {
      throw new Error("Tailwind 没有生成任何 CSS");
    }
    return css;
  } catch (err) {
    // 样式是交付物的一部分。吞掉这里的错误会让一份写满 Tailwind 类名的页面
    // 退化成浏览器默认 HTML，却仍被构建门、QA 和交付验收判绿。
    throw new Error(
      `Tailwind CSS 编译失败:${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const RUNTIME_SOURCES = new Set(["/db.js", "/index.js"]);

/**
 * 生成物的样式入口。
 * preflight 必须留着 —— 它是 Tailwind 的样式重置,少了它按钮、标题、列表
 * 会带上浏览器默认样式,页面看起来会明显"脏"。
 */
const TAILWIND_ENTRY = `@import "tailwindcss";`;

function formatMessage(m: esbuild.Message): string {
  const loc = m.location;
  const where = loc ? ` (${loc.file}:${loc.line}:${loc.column})` : "";
  const snippet = loc?.lineText ? `\n    ${loc.lineText.trim()}` : "";
  return `${m.text}${where}${snippet}`;
}

/**
 * 生成物的宿主页面。
 *
 * bundle 直接内联,整个应用就是**一个自包含的 HTML 文档** —— 一次请求、
 * 没有二次往返、也不存在缓存失效问题(修复循环会换掉产物)。
 * 存成文件双击就能跑,这一点比拆成多个静态资源更贴近「产物」的语义。
 *
 * 样式也是构建期编译好的 —— 整个文档不引用任何外部资源,断网可用。
 */
export function appHtml(opts: {
  title: string;
  js: string;
  /** 构建期编译好的 Tailwind,只含用到的类 */
  css: string;
  runId: string;
  apiBase: string;
  /** 嵌在工作区预览里时不显示底部信息条 */
  embed?: boolean;
}): string {
  const config = JSON.stringify({ runId: opts.runId, api: opts.apiBase });
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(opts.title)}</title>
<style>${opts.css}</style>
<style>
  body { margin: 0; font-family: system-ui, -apple-system, "PingFang SC", sans-serif; }
  /*
   * 出生证明做成右下角的小胶囊,不做通栏横条。
   *
   * 原先是钉在底部的整条深色 bar。两个问题,在真实生成物上一眼就能看见:
   * 固定定位的横条在滚动时会一直压住视口底部的内容(body 的 padding-bottom
   * 只能保护文档末尾,保护不了滚动途中),而且一条深色通栏压在人家精心配好的
   * 暖色调品牌页上,是**平台在损害它自己交付的产品**。
   *
   * 平台的标识不该比产品本身更显眼。收起来,让位给内容。
   */
  #glassbox-bar {
    position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
    display: inline-flex; align-items: center; gap: 8px;
    max-width: calc(100vw - 24px);
    padding: 6px 10px; font-size: 11px; line-height: 1.4;
    border-radius: 999px;
    background: rgba(13, 15, 20, 0.82);
    -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
    color: #97a1b2; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    opacity: 0.72; transition: opacity 0.15s ease;
  }
  #glassbox-bar:hover { opacity: 1; }
  #glassbox-bar a { color: #6ee7b7; text-decoration: none; white-space: nowrap; }
  #glassbox-bar a:hover { text-decoration: underline; }
  #glassbox-bar button {
    background: none; border: 0; color: #6b7688; cursor: pointer; font-size: 12px; padding: 0 2px;
  }
  /* 窄屏上只留链接,免得一个角标占掉半个屏幕 */
  @media (max-width: 520px) { #glassbox-bar .gb-note { display: none; } }
</style>
<script>window.__GLASSBOX__ = ${config};</script>
</head>
<body>
<div id="root"></div>
${opts.embed ? "" : birthCertificate(opts.runId)}
<script>${opts.js}</script>
</body>
</html>`;
}

/**
 * 「出生证明」信息条。
 *
 * 每个发布出去的应用都附带自己完整的生成过程回放。据我所知没有同类产品这么做,
 * 而它几乎是免费的 —— 事件流本来就在。一个应用不仅能用,还能自证它是怎么来的。
 */
function birthCertificate(runId: string): string {
  return `<div id="glassbox-bar">
  <span class="gb-note">数据真实持久 · 刷新仍在</span>
  <a href="/r/${encodeURIComponent(runId)}" target="_blank" rel="noopener">看它是怎么被造出来的 ↗</a>
  <button onclick="document.getElementById('glassbox-bar').remove()" title="收起">✕</button>
</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------- 兜底页面 ------------------------- */

function shell(title: string, inner: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    "<title>" + escapeHtml(title) + "</title>",
    "<style>",
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;",
    'background:#08090c;color:#97a1b2;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}',
    ".box{max-width:640px;padding:32px}",
    "h1{font-size:15px;font-weight:500;color:#c3cad6;margin:0 0 12px}",
    "pre{white-space:pre-wrap;word-break:break-word;background:#0d0f14;border:1px solid #222834;",
    "border-radius:8px;padding:12px;font-size:11px;line-height:1.6;color:#c3cad6;overflow:auto;max-height:50vh}",
    "a{color:#34d399}",
    "</style></head><body><div class=\"box\">",
    inner,
    "</div></body></html>",
  ].join("");
}

/** 找不到应用时的页面 */
export function notFoundPage(message: string): string {
  return shell(
    "Glassbox",
    "<h1>" + escapeHtml(message) + '</h1><p style="font-size:13px"><a href="/">去造一个 →</a></p>',
  );
}

/**
 * 构建失败页。
 * 正常流程里构建不通过的产物根本不会被发布(流水线里就拦住了),
 * 走到这里说明是历史数据或平台契约变更导致的 —— 如实说明,而不是白屏。
 */
export function buildErrorPage(runId: string, errors: string[]): string {
  const detail = escapeHtml(errors.join("\n\n"));
  const link = "/r/" + encodeURIComponent(runId);
  return shell(
    "构建失败 · Glassbox",
    "<h1>这个应用当前无法构建</h1><pre>" +
      detail +
      '</pre><p style="font-size:13px;margin-top:16px"><a href="' +
      link +
      '">查看它的生成过程 →</a></p>',
  );
}
