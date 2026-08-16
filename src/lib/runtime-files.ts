/**
 * 平台注入进生成物的运行时契约。
 *
 * 这两个文件构成「Glassbox 平台」与「被生成的应用」之间的契约,由平台提供而非 LLM 生成:
 *   /db.js     → 真实的服务端持久化 SDK(对标 Atoms Cloud Backend)
 *   /index.js  → 挂载入口 + 错误捕获 + 健康探针
 *
 * 关键设计:校验不是「构建通过就算过」。构建通过 ≠ 页面能用 —— 语法正确但
 * useEffect 里抛异常、或渲染出一片空白,是 LLM 生成代码最常见的两种失败,
 * 而它们都能骗过编译器。所以 /index.js 里装了错误捕获和空白探针,
 * 把**运行时真相**主动回传给平台,再由平台回喂给工程师修复。
 *
 * 宿主页面(见 builder.ts 的 appHtml)会在加载 bundle 之前写入 window.__GLASSBOX__,
 * 所以这里直接读全局配置,不需要构建期做字符串替换。
 */

export const DB_MODULE = `/**
 * Glassbox 数据服务 —— 由平台注入,数据真实存储在服务端。
 * 刷新页面、换浏览器打开分享链接,数据都还在。
 */
const cfg = (typeof window !== "undefined" && window.__GLASSBOX__) || {};
const API = cfg.api || "";
const RUN_ID = cfg.runId || "";

async function call(collection, init) {
  const res = await fetch(
    API + "/api/appdata/" + encodeURIComponent(RUN_ID) + "/" + encodeURIComponent(collection),
    { headers: { "Content-Type": "application/json" }, ...init }
  );
  if (!res.ok) {
    throw new Error("db " + res.status + ": " + (await res.text()).slice(0, 200));
  }
  return res.json();
}

export const db = {
  /** 读取整个集合,按插入顺序 */
  list(collection) {
    return call(collection, { method: "GET" });
  },
  /** 插入一条记录,平台自动补 id 与 createdAt */
  insert(collection, data) {
    return call(collection, { method: "POST", body: JSON.stringify(data) });
  },
  /** 局部更新一条记录 */
  update(collection, id, patch) {
    return call(collection, { method: "PATCH", body: JSON.stringify({ id, patch }) });
  },
  /** 删除一条记录 */
  remove(collection, id) {
    return call(collection, { method: "DELETE", body: JSON.stringify({ id }) });
  },
};

export default db;
`;

export const INDEX_JS = `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

/* ---------- 运行时探针:把真实运行状况回传给 Glassbox 平台 ---------- */

function report(payload) {
  try {
    // 嵌在工作区里时 parent 是平台页面;独立打开时 parent 就是自己,发了也无害
    window.parent.postMessage({ __glassbox: true, ...payload }, "*");
  } catch (_) {}
}

window.addEventListener("error", (e) => {
  report({
    kind: "runtime",
    message: (e && e.message) || "未捕获错误",
    stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 800) : "",
  });
});

window.addEventListener("unhandledrejection", (e) => {
  const r = e && e.reason;
  report({
    kind: "runtime",
    message: "未处理的 Promise 拒绝: " + (r && r.message ? r.message : String(r)),
    stack: r && r.stack ? String(r.stack).slice(0, 800) : "",
  });
});

/** 渲染期错误单独兜住,否则 React 会静默卸载整棵树,表现为白屏 */
class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, message: "" };
  }
  static getDerivedStateFromError(error) {
    return { failed: true, message: error && error.message ? error.message : String(error) };
  }
  componentDidCatch(error, info) {
    report({
      kind: "runtime",
      message: "渲染抛错: " + (error && error.message ? error.message : String(error)),
      stack: info && info.componentStack ? String(info.componentStack).slice(0, 800) : "",
    });
  }
  render() {
    if (this.state.failed) {
      return React.createElement(
        "div",
        { style: { padding: 24, fontFamily: "system-ui", color: "#b91c1c" } },
        "运行时错误:" + this.state.message
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById("root");

// 这里不套 StrictMode:开发期的双挂载会让 useEffect 里的 db 写入跑两次,
// 体检结果会被这种自造的噪音污染。校验环境要尽量贴近用户真实打开时的样子。
createRoot(container).render(
  React.createElement(Boundary, null, React.createElement(App))
);

/* 空白探针:能构建、能挂载,但什么都没渲染出来,同样是失败 */
setTimeout(() => {
  // innerText 更准(会排除隐藏元素),但不是所有环境都实现它 ——
  // 无头环境里它是 undefined,只认 innerText 会把正常页面误判成白屏。
  // 判空这种关键判据不能押在一个可选 API 上。
  const raw = container.innerText != null ? container.innerText : container.textContent;
  const text = (raw || "").trim();
  const nodes = container.querySelectorAll("*").length;
  // 一个字都没有就是坏的 —— 哪怕 DOM 里挂了一堆空容器。
  // 只判断节点数会放过「骨架渲染出来了但数据渲染没接上」这种失败。
  if (text.length === 0 || nodes < 3) {
    report({
      kind: "blank",
      message: "页面挂载后无任何可见内容(疑似渲染为空,或数据加载完成后未渲染)",
    });
  } else {
    report({ kind: "ok", message: "已渲染 " + nodes + " 个节点" });
  }
}, 1800);
`;

export const RUNTIME_PATHS = new Set(["/db.js", "/index.js"]);

/**
 * 注入平台运行时。
 *
 * 这两个文件不由 LLM 生成 —— 它们是生成物与平台之间的契约,交给 LLM 写
 * 就等于每次生成都在赌它不会写错持久化层。契约必须是确定的。
 *
 * 注意这里是**覆盖式**注入,且每次构建前都会重跑:平台运行时属于平台,
 * 不应该被冻结在某次历史 run 的产物里。平台升级后,旧 run 重新打开时用的也是新契约。
 */
export function withRuntimeFiles(
  files: { path: string; content: string }[],
): { path: string; content: string }[] {
  const map = new Map(files.map((f) => [f.path, f]));
  map.set("/db.js", { path: "/db.js", content: DB_MODULE });
  map.set("/index.js", { path: "/index.js", content: INDEX_JS });
  // 宿主页面由服务端生成,LLM 若产出了 index.html 一律忽略
  map.delete("/public/index.html");
  map.delete("/index.html");
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}
