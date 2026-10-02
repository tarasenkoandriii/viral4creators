/**
 * Шаблон GTM «Custom HTML» (Э3, T): после подстановки {{ORIGIN}} и {{PK}}
 * — РОВНО тег из TMA (`sites-backend/.../assist-site-setup/snippet.ts`
 * `buildEmbedSnippet`, его же отдаёт `installGuides.gtm.html`). Разойдутся —
 * заказчик, ставящий через GTM, получит не тот тег, что ждёт загрузчик.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WIDGET_LOADER_PATH } from "../npm/src/brand";

// Путь — переменной: typecheck пакета не должен идти в исходники бэкенда
// (у них свой tsconfig), а tsx исполнит их как есть.
const snippetPath = fileURLToPath(
  new URL(
    "../../sites-backend/src/modules/assist-site-setup/snippet.ts",
    import.meta.url,
  ),
);
const snippet = (await import(snippetPath)) as {
  buildEmbedSnippet(o: { publicKey: string; widgetOrigin: string }): string;
};

const raw = readFileSync(
  new URL("../gtm/custom-html.html", import.meta.url),
  "utf8",
);
// Без HTML-комментария — он для человека в GTM.
const template = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
assert.ok(template.includes("{{ORIGIN}}") && template.includes("{{PK}}"));
assert.ok(
  template.includes(`{{ORIGIN}}${WIDGET_LOADER_PATH}`),
  "путь загрузчика в шаблоне ≠ WIDGET_LOADER_PATH бренда",
);

for (const [pk, origin] of [
  ["pk_live_AbCdEfGhIjKlMnOpQrStUvWx", "https://w.example.com"],
  ["pk_test_000000000000000000000000", "https://w.v4c.example.invalid"],
]) {
  const filled = template
    .split("{{ORIGIN}}")
    .join(origin)
    .split("{{PK}}")
    .join(pk);
  assert.equal(
    filled,
    snippet.buildEmbedSnippet({ publicKey: pk, widgetOrigin: origin }),
  );
}
console.log("gtm: шаблон совпадает с кодом вставки TMA");
