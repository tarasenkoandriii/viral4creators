/**
 * Зеркала бренда (Э3): npm/src/brand.ts и wordpress/…/includes/brand.php
 * совпадают с sites-backend/src/brand.ts; имя пакета npm и слаг плагина —
 * из бренда. Расхождение = плагин/пакет зовёт путь, которого сервер не знает.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as brand from "../npm/src/brand";

const backend = readFileSync(
  new URL("../../sites-backend/src/brand.ts", import.meta.url),
  "utf8",
);
const constOf = (name: string): string => {
  const m = backend.match(
    new RegExp(`export const ${name}\\s*=\\s*'([^']*)';`),
  );
  assert.ok(m, `sites-backend/src/brand.ts: нет ${name}`);
  return m![1];
};
for (const [name, value] of Object.entries(brand)) {
  assert.equal(value, constOf(name), `${name}: npm «${value}» ≠ бэкенд`);
}
const pkg = JSON.parse(
  readFileSync(new URL("../npm/package.json", import.meta.url), "utf8"),
) as { name: string };
assert.equal(
  pkg.name,
  constOf("WIDGET_NPM_PACKAGE"),
  "имя npm-пакета ≠ WIDGET_NPM_PACKAGE",
);

const php = readFileSync(
  new URL("../wordpress/v4c-assist/includes/brand.php", import.meta.url),
  "utf8",
);
for (const [phpName, tsName] of [
  ["V4C_ASSIST_WIDGET_ORIGIN_DEFAULT", "WIDGET_ORIGIN_DEFAULT"],
  ["V4C_ASSIST_LOADER_PATH", "WIDGET_LOADER_PATH"],
  ["V4C_ASSIST_GLOBAL", "WIDGET_GLOBAL"],
  ["V4C_ASSIST_PLUGIN_SLUG", "WP_PLUGIN_SLUG"],
  ["V4C_ASSIST_SIGNATURE_HEADER", "GOAL_WEBHOOK_SIGNATURE_HEADER"],
] as const) {
  const m = php.match(
    new RegExp(`define\\(\\s*'${phpName}',\\s*'([^']*)'\\s*\\)`),
  );
  assert.ok(m, `brand.php: нет ${phpName}`);
  assert.equal(m![1], constOf(tsName), `${phpName} ≠ ${tsName}`);
}
console.log("brand: зеркала npm и WordPress совпадают с sites-backend");
