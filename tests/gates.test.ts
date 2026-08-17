/**
 * 门注册表。
 *
 * 这层的价值全在几条不变量上,所以测试也只盯这几条:
 *   1. 由产物触发 —— 出现新代码就必然构建、必然审计,不管流程走到哪
 *   2. 阻塞门不过就停,且**不再跑后面的**(编译不过时审计它的写法是浪费)
 *   3. 非阻塞门不过照样放行,但事实要留下
 *   4. 注册表运行期改不动 —— 这是「调度器无权关门」的实现方式
 */

import assert from "node:assert/strict";
import { GATES, runGates, type Gate } from "../src/lib/gates";
import { RUNTIME_PATHS, withRuntimeFiles } from "../src/lib/runtime-files";

let passed = 0;
function ok(label: string) {
  passed++;
  console.log(`Gates · ✓ ${label}`);
}

const goodApp = withRuntimeFiles([
  {
    path: "/App.js",
    content: `export default function App(){ return <h1 className="text-2xl text-[#1e3a5f]">记账本</h1>; }`,
  },
]);

const brokenApp = withRuntimeFiles([
  { path: "/App.js", content: `export default function App(){ return <h1>没闭合 }` },
]);

/** 计时器没有清理路径 —— 静态审计该拦的确定性写法 */
const leakyApp = withRuntimeFiles([
  {
    path: "/App.js",
    content: `import { useEffect } from "react";
export default function App(){
  useEffect(() => { setInterval(() => console.log("tick"), 1000); }, []);
  return <h1 className="text-2xl text-[#1e3a5f]">番茄钟</h1>;
}`,
  },
]);

async function main() {
  /* --- 触发点决定跑哪些门 --- */
  {
    const onFiles = GATES.filter((g) => g.on === "artifact:files").map((g) => g.id);
    assert.deepEqual(onFiles, ["build", "static-audit"], "出现新代码必然跑这两道");
    assert.ok(
      GATES.some((g) => g.on === "artifact:tests" && g.id === "test-plan"),
      "测试计划有自己的触发点",
    );
    ok("门挂在产物上,不挂在流程位置上");
  }

  /* --- 构建通过,继续跑静态审计 --- */
  {
    const r = await runGates("artifact:files", { runId: "g1", files: goodApp });
    assert.equal(r.passed, true, `健康代码应全过:${JSON.stringify(r.facts)}`);
    assert.equal(r.verdicts.length, 2, "两道门都该跑到");
    ok("健康代码两道门都通过");
  }

  /* --- 构建挂了就立刻停,不再跑静态审计 --- */
  {
    const r = await runGates("artifact:files", { runId: "g2", files: brokenApp });
    assert.equal(r.passed, false);
    assert.equal(r.verdicts.length, 1, "阻塞门不过必须立刻停,不跑后面的");
    assert.equal(r.verdicts[0].gate, "build");
    assert.ok(r.facts.length > 0, "要把编译器的原话带出来");
    ok("阻塞门不过就停,不再跑后面的门");
  }

  /* --- 静态审计拦住注定出问题的写法 --- */
  {
    const r = await runGates("artifact:files", { runId: "g3", files: leakyApp });
    assert.equal(r.passed, false, "setInterval 没有清理路径必须被拦");
    assert.equal(r.verdicts.at(-1)?.gate, "static-audit", "是审计门拦的,不是构建门");
    assert.ok(
      r.facts.some((f) => /clearInterval|清理/.test(f)),
      "要说清为什么拦",
    );
    ok("静态审计拦住计时器无清理路径(构建是过的)");
  }

  /* --- 非阻塞门:不过也放行,但事实留下 --- */
  {
    const r = await runGates("artifact:tests", {
      runId: "g4",
      files: goodApp,
      // 「卡片分组」界面上不存在 —— target 门该有意见
      cases: [
        {
          name: "编造的控件名",
          steps: [{ action: "expectTextWithin", target: "卡片分组", text: "x" }],
        },
      ],
      screenNames: ["记账本"],
    });
    assert.equal(r.passed, true, "非阻塞门不过不能挡住流程");
    assert.equal(r.verdicts[0].ok, false, "但它确实判为不合格");
    assert.equal(r.verdicts[0].blocking, false);
    assert.ok(r.facts.length > 0, "事实必须留下,喂给调度器");
    ok("非阻塞门不过照样放行,但事实进得去");
  }

  /* --- 注册表运行期改不动 --- */
  {
    assert.ok(Object.isFrozen(GATES), "注册表必须冻结");
    assert.throws(
      () => {
        (GATES as Gate[]).push({
          id: "fake",
          name: "假门",
          on: "artifact:files",
          blocking: false,
          async run() {
            return { ok: true, facts: [] };
          },
        });
      },
      /read.only|extensible|frozen/i,
      "运行期不该能往注册表里塞门",
    );
    ok("注册表运行期改不动(调度器无权关门的实现方式)");
  }

  /* --- 运行时文件不该被当成用户代码审计 --- */
  {
    assert.ok(RUNTIME_PATHS.size > 0, "平台注入的运行时文件有明确清单");
    ok("平台注入文件有独立清单,便于与用户代码区分");
  }

  console.log(`\n全部通过:${passed} 项`);
}

main().catch((e) => {
  console.error("\n✗ 失败:", e);
  process.exit(1);
});
