import {
  appHtml,
  buildApp,
  buildErrorPage,
  hasUsableGeneratedCss,
  notFoundPage,
} from "@/lib/builder";
import { foldEvents } from "@/lib/fold";
import { withRuntimeFiles } from "@/lib/runtime-files";
import { getStore, type AppBundleStage } from "@/lib/store";

export const runtime = "nodejs";

/**
 * 已发布的应用 —— 生成物自己的公开地址。
 *
 * 这是一个 route handler 而不是 React 页面:返回的就是一份普通 HTML,
 * 没有平台外壳、没有框架运行时开销。任何人拿到链接直接就能用,数据真实持久。
 * 这才叫「上线」,而不是「在预览面板里能看到」。
 *
 * 新运行会在生成阶段保存已编译 bundle：embed 预览读取 candidate，公开链接读取
 * published。浏览器校验成功才原子晋升，因此继续修改时公开链接始终停在最近稳定版。
 * 历史运行没有 bundle 时仍可从事件流重建一次并回填，保持向后兼容。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  const url = new URL(req.url);
  const embed = url.searchParams.has("embed");
  const store = getStore();
  const run = await store.getRun(runId);
  if (!run) {
    return html(notFoundPage("找不到这个应用"), 404);
  }

  const stage: AppBundleStage = embed ? "candidate" : "published";
  const stored = await store.getAppBundle(runId, stage);
  const title = run.label || run.prompt || "VibeU App";
  // 旧版本曾在 Tailwind 编译失败时把空 CSS 当成功 bundle 存库。不能继续返回
  // 那份浏览器默认样式；落到下方，用事件里的源码按当前构建器自动重建。
  if (stored && hasUsableGeneratedCss(stored.css)) {
    return html(
      appHtml({
        title,
        js: stored.js,
        css: stored.css,
        runId,
        apiBase: url.origin,
        embed,
      }),
      200,
      stage,
    );
  }

  if (!embed && run.status !== "succeeded") {
    return html(notFoundPage("这个应用仍在验收，公开版本尚未发布"), 409);
  }

  const events = await store.readEvents(runId);
  if (events.length === 0) {
    return html(notFoundPage("找不到这个应用"), 404);
  }

  const state = foldEvents(events);
  if (state.files.length === 0) {
    return html(notFoundPage("这次生成还没有产出可运行的应用"), 404);
  }

  const built = await buildApp(withRuntimeFiles(state.files));
  if (!built.ok) {
    const messages = built.errors.map((e) => e.message);
    return html(buildErrorPage(runId, messages), 500);
  }

  const bundle = {
    js: built.js,
    css: built.css,
    bytes: built.bytes,
    updatedAt: Date.now(),
  };
  await store.saveAppBundle(runId, bundle);
  if (!embed && run.status === "succeeded") {
    await store.publishAppBundle(runId);
  }

  const page = appHtml({
    title,
    js: bundle.js,
    css: bundle.css,
    runId,
    apiBase: url.origin,
    embed,
  });
  return html(page, 200, embed ? "candidate" : "published");
}

function html(body: string, status = 200, stage?: AppBundleStage) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // 同一个稳定链接会在下一版验收通过后切换 bundle，先不引入 CDN 缓存失效复杂度。
      "Cache-Control": "no-store",
      ...(stage ? { "X-VibeU-Bundle-Stage": stage } : {}),
    },
  });
}
