import assert from "node:assert/strict";
import { runTests } from "../src/lib/testrunner";

async function main() {
  const report = await runTests(
    '<!doctype html><html><body><button disabled>提交预订</button></body></html>',
    "boolean-attribute",
    [
      {
        name: "HTML 布尔属性按存在性断言",
        steps: [
          { action: "expectAttribute", target: "提交预订", attr: "disabled", value: "true" },
        ],
      },
    ],
  );
  assert.equal(report.failed, 0, JSON.stringify(report.failures, null, 2));
  console.log("Boolean attribute · ✓ disabled=\"\" 可按布尔 true 断言");
}

void main();
