import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const block = workflow
  .split("  next-apps:\n")[1]
  .split("\n  # Реле живого входа")[0];
test("required Next app check names exist even for an empty change selection", () => {
  assert.match(block, /app: \[admin, landing, marketplace\]/);
  assert.match(block, /if: needs\.changes\.outputs\.next_apps != ''/);
  assert.doesNotMatch(block, /next_apps != '\[\]'/);
  assert.match(block, /name: \$\{\{ matrix\.app \}\} — типы и сборка/);
});
test("unchanged apps avoid installs and builds, changed apps retain every verification step", () => {
  const steps = block.split(/\n      - /).slice(1);
  assert.ok(steps.length >= 12);
  for (const step of steps) {
    if (step.startsWith("name: unchanged application")) {
      assert.match(
        step,
        /!contains\(fromJSON\(needs\.changes\.outputs\.next_apps\), matrix\.app\)/,
      );
    } else {
      assert.match(
        step,
        /\n        if: contains\(fromJSON\(needs\.changes\.outputs\.next_apps\), matrix\.app\)/,
      );
    }
  }
  for (const command of [
    "npm ci",
    "npm audit",
    "npx tsc",
    "npm run lint",
    "npm run test",
    "npx next build",
    "npm run budget:js",
  ]) {
    assert.ok(block.includes(command), command);
  }
});

for (const job of ["backend", "frontend"]) {
  test(`${job}: required check succeeds without expensive work when unchanged`, () => {
    const block = workflow.split(`  ${job}:\n`)[1].split(/\n  (?:[a-z][a-z-]*:|#)/)[0];
    assert.ok(block.includes(`if: needs.changes.outputs.${job} != ''`));
    const steps = block.split(/\n      - /).slice(1);
    assert.ok(steps.length > 5);
    for (const step of steps) {
      const selected = step.startsWith("name: unchanged application") ? "false" : "true";
      assert.ok(step.includes(`\n        if: needs.changes.outputs.${job} == '${selected}'`));
    }
    assert.ok(block.includes("npm ci"));
    assert.ok(block.includes("npm audit"));
    assert.ok(block.includes("tsc --noEmit"));
    assert.ok(block.includes("eslint") || block.includes("npm run lint"));
    assert.ok(block.includes("npx jest") || block.includes("npm test"));
  });
}
