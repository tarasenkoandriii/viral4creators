/**
 * Сборка npm-пакета (Э3, T): `npm pack --dry-run` — в архиве только
 * package.json и dist/*.js|*.d.ts трёх входов (+ бренд). Ни исходников,
 * ни тестов, ни секретов из fixtures. Собирает сам (CI гоняет тесты до build).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npmDir = fileURLToPath(new URL("../npm", import.meta.url));
execFileSync("npx", ["tsc", "-p", "npm/tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
const out = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    cwd: npmDir,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
  },
);
const [info] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
const files = info.files.map((f) => f.path).sort();
assert.deepEqual(files, [
  "dist/brand.d.ts",
  "dist/brand.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/react.d.ts",
  "dist/react.js",
  "dist/server.d.ts",
  "dist/server.js",
  "package.json",
]);
console.log(`pack: ${files.length} файлов, лишних нет`);
