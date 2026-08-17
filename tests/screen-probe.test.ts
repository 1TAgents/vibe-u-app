/**
 * 界面探查 —— 写测试计划前把应用真的跑一遍,采下 Tess 实际能定位到的控件名。
 *
 * 这道工序存在的理由是:她只看源码时会**猜**控件叫什么,而源码里有某个字符串
 * 不代表界面上定位得到(它可能在还没打开的弹窗里)。所以这里验的不是"能采到东西",
 * 而是三件更具体的事:
 *   1. 藏在交互后面的字段能被挖出来(第 2、3 层),这是首屏清单救不了的那部分
 *   2. 没真的发生的事绝不能报成一层 —— 报一个假的第 3 层,等于把她引向不存在的控件
 *   3. 探查会真的写数据,必须写进一次性命名空间,不能污染交付给用户的应用
 */

import assert from "node:assert/strict";
import { collectScreenInventory } from "../src/lib/delivery";
import { handleAppData } from "../src/lib/appdata";

let passed = 0;
function ok(label: string) {
  passed++;
  console.log(`ScreenProbe · ✓ ${label}`);
}

/** 一个不依赖框架的最小应用:首屏只有入口,表单在弹窗里,提交后长出记录 */
function app(opts: { persist?: boolean; brokenSubmit?: boolean } = {}) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body><div id="root">
  <h1>书摘</h1>
  <button id="entry">新书入架</button>
  <div id="form" style="display:none">
    <input id="t" placeholder="输入书名">
    <input id="a" placeholder="输入作者">
    <button id="save">保存</button>
  </div>
  <section id="list" aria-label="书架"></section>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  $("entry").onclick = () => { $("form").style.display = "block"; };
  $("save").onclick = async () => {
    const name = $("t").value;
    if (!name) return;
    ${opts.brokenSubmit ? "return;" : ""}
    ${
      opts.persist
        ? `await fetch("/api/appdata/REAL_RUN/books", {
             method: "POST",
             headers: { "Content-Type": "application/json" },
             body: JSON.stringify({ name }),
           });`
        : ""
    }
    $("form").style.display = "none";
    const b = document.createElement("button");
    b.setAttribute("aria-label", name + " 删除");
    b.textContent = "删除";
    $("list").appendChild(b);
  };
</script></body></html>`;
}

/** 首屏有多个更短导航项时，「记支出」仍应被优先识别为表单入口。 */
function ledgerApp() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body><div id="root">
  <button>首页</button><button>统计</button><button>流水</button><button>设置</button>
  <button id="expense">记支出</button>
  <div id="form" style="display:none">
    <input placeholder="金额"><button>保存支出</button>
  </div>
</div><script>
  document.getElementById("expense").onclick = () => {
    document.getElementById("form").style.display = "block";
  };
</script></body></html>`;
}

async function main() {
  {
    const inv = await collectScreenInventory(ledgerApp(), "ledger-probe");
    assert.equal(inv.afterOpen?.via, "记支出");
    assert.ok(inv.afterOpen?.inputs.includes("金额"));
    ok("多导航首屏仍优先打开记支出表单");
  }

  /* --- 交互后面的字段能被挖出来 --- */
  {
    const inv = await collectScreenInventory(app(), "p1");
    assert.deepEqual(inv.inputs, [], "首屏本来就没有输入框");
    assert.ok(inv.clickables.includes("新书入架"), "首屏入口应被采到");

    assert.ok(inv.afterOpen, "点开入口后应探到第 2 层");
    assert.equal(inv.afterOpen!.via, "新书入架", "应记下是点了哪个控件打开的");
    assert.ok(
      inv.afterOpen!.inputs.includes("输入书名"),
      "弹窗里的字段正是首屏清单救不了的那部分",
    );
    ok("挖出弹窗里的表单字段(首屏一个输入框都没有)");

    assert.ok(inv.afterCreate, "填完提交后应探到第 3 层");
    assert.ok(
      inv.afterCreate!.clickables.some((c) => c.includes("删除")),
      "每条记录自己的操作按钮只有有记录之后才存在",
    );
    ok("造出记录后采到记录级操作按钮(组合命名格式可见)");
  }

  /* --- 没发生的事不能报成一层 --- */
  {
    const inv = await collectScreenInventory(app({ brokenSubmit: true }), "p2");
    assert.ok(inv.afterOpen, "表单还是能打开");
    assert.equal(
      inv.afterCreate,
      undefined,
      "提交没生效就绝不能报第 3 层 —— 否则等于把 Tess 引向一批不存在的控件",
    );
    ok("提交没生效时不报假的第 3 层");
  }

  /* --- 探查的写入不能污染真实应用 --- */
  {
    await collectScreenInventory(app({ persist: true }), "REAL_RUN");
    const after = await handleAppData("REAL_RUN", "books", "GET", undefined);
    const rows = (after.body as { items?: unknown[] }).items ?? [];
    assert.equal(
      rows.length,
      0,
      "探查会真的填表提交,但这些数据必须落在一次性命名空间 —— " +
        "交付给用户的应用里不能躺着「探查样例」",
    );
    ok("探查写入被隔离,不污染交付给用户的数据");
  }

  console.log(`\n全部通过:${passed} 项`);
}

main().catch((e) => {
  console.error("\n✗ 失败:", e);
  process.exit(1);
});
