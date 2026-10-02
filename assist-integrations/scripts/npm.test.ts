/**
 * npm-пакет (Э3, T): подпись вебхука и userHash — по ОБЩИМ векторам
 * (fixtures/goal-webhook-vectors.json, их же проверяют sites-backend и
 * PHP-плагин); тег загрузчика — те же атрибуты, что читает загрузчик,
 * значения не ломают разметку (setAttribute, не строка HTML); очередь
 * вызовов до загрузки; один тег на страницу; SSR — no-op.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WIDGET_GLOBAL, WIDGET_LOADER_PATH } from "../npm/src/brand";
import { loadAssist, loaderAttributes } from "../npm/src/index";
import {
  goalWebhookRequest,
  identityUserHash,
  signGoalWebhook,
} from "../npm/src/server";

interface Vectors {
  webhook: Array<{ secret: string; body: string; t: number; header: string }>;
  identity: Array<{ secret: string; externalId: string; userHash: string }>;
}
const vectors = JSON.parse(
  readFileSync(
    new URL("../fixtures/goal-webhook-vectors.json", import.meta.url),
    "utf8",
  ),
) as Vectors;

assert.ok(vectors.webhook.length >= 3 && vectors.identity.length >= 2);
for (const v of vectors.webhook) {
  assert.equal(signGoalWebhook(v.secret, v.body, v.t), v.header);
  // Чужой секрет и изменённое тело — другая подпись.
  assert.notEqual(signGoalWebhook(`${v.secret}x`, v.body, v.t), v.header);
  assert.notEqual(signGoalWebhook(v.secret, `${v.body} `, v.t), v.header);
}
for (const v of vectors.identity) {
  assert.equal(identityUserHash(v.secret, v.externalId), v.userHash);
}
assert.throws(() => signGoalWebhook("", "{}", 1));
assert.throws(() => signGoalWebhook("s", "{}", 1.5));
assert.throws(() => identityUserHash("s", ""));

// Готовый запрос: подпись по тем же байтам, что уходят в теле.
{
  const v = vectors.webhook[0];
  const event = JSON.parse(v.body);
  const req = goalWebhookRequest(v.secret, event, v.t);
  assert.equal(req.body, v.body);
  assert.equal(req.headers["X-Assist-Signature"], v.header);
  assert.equal(req.headers["Idempotency-Key"], event.orderId);
}

// ── Тег загрузчика ────────────────────────────────────────────────────
const PK = "pk_live_AbCdEfGhIjKlMnOpQrStUvWx";
assert.deepEqual(
  loaderAttributes({ siteKey: PK, origin: "https://w.example.com/" }),
  [
    ["src", `https://w.example.com${WIDGET_LOADER_PATH}`],
    ["data-site", PK],
  ],
);
const full = Object.fromEntries(
  loaderAttributes({
    siteKey: PK,
    origin: "https://w.example.com",
    position: "top-left",
    offsetX: 10,
    offsetY: 999, // вне диапазона — атрибут не ставится
    lang: "auto", // auto — умолчание загрузчика, атрибут не нужен
    mobile: "sheet",
    launcher: "none",
    zIndex: 5,
    hideOn: ["/checkout*", "javascript:x", "/a,b", "/cart"],
  }),
);
assert.deepEqual(full, {
  src: `https://w.example.com${WIDGET_LOADER_PATH}`,
  "data-site": PK,
  "data-position": "top-left",
  "data-offset-x": "10",
  "data-mobile": "sheet",
  "data-launcher": "none",
  "data-z-index": "5",
  "data-hide-on": "/checkout*,/cart",
});
assert.throws(() => loaderAttributes({ siteKey: 'pk"><script>' }), /siteKey/);
assert.throws(
  () => loaderAttributes({ siteKey: PK, origin: "http://w.example.com" }),
  /https/,
);
assert.throws(
  () => loaderAttributes({ siteKey: PK, origin: "https://u:p@w.example.com" }),
  /логина/,
);
assert.ok(
  loaderAttributes({
    siteKey: PK,
    origin: "http://localhost:5176",
  })[0][1].startsWith("http://localhost:5176/"),
);

// SSR: ни window, ни document — вызовы пустые, ничего не падает.
{
  const api = loadAssist({ siteKey: PK });
  api.open();
  api.goal("lead");
  api.destroy();
}

// ── Страница: минимальный DOM ─────────────────────────────────────────
class FakeScript {
  async = false;
  nonce = "";
  attrs: Record<string, string> = {};
  parentNode: FakeHead | null = null;
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
  }
}
class FakeHead {
  children: FakeScript[] = [];
  appendChild(s: FakeScript) {
    s.parentNode = this;
    this.children.push(s);
  }
  removeChild(s: FakeScript) {
    this.children = this.children.filter((x) => x !== s);
    s.parentNode = null;
  }
}
const head = new FakeHead();
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.document = {
  head,
  body: head,
  createElement: (tag: string) => {
    assert.equal(tag, "script");
    return new FakeScript();
  },
};

const api = loadAssist({
  siteKey: PK,
  origin: "https://w.example.com",
  nonce: "n0",
});
assert.equal(head.children.length, 1);
const tag = head.children[0];
assert.equal(tag.async, true);
assert.equal(tag.nonce, "n0");
assert.equal(tag.attrs["data-site"], PK);
// Повторный вызов — тот же экземпляр, второго тега нет.
assert.equal(loadAssist({ siteKey: PK, origin: "https://w.example.com" }), api);
assert.equal(head.children.length, 1);

// До загрузки вызовы копятся в очереди `V4CAssist.q` — её забирает загрузчик.
api.goal("purchase", { value: 1299, currency: "UAH", orderId: "A-1042" });
api.identify({ externalId: "customer-42", userHash: "abc" });
api.open();
const stub = g[WIDGET_GLOBAL] as { q: unknown[][] };
assert.deepEqual(
  stub.q.map((c) => Array.from(c)),
  [
    ["goal", "purchase", { value: 1299, currency: "UAH", orderId: "A-1042" }],
    ["identify", { externalId: "customer-42", userHash: "abc" }],
    ["open"],
  ],
);

// Загрузчик заменил глобал — вызовы идут в него.
const seen: unknown[][] = [];
const loaded = Object.assign((...a: unknown[]) => seen.push(a), {
  l: 1 as const,
});
g[WIDGET_GLOBAL] = loaded;
api.ask("Є доставка?");
assert.deepEqual(seen, [["ask", "Є доставка?"]]);

// destroy: загрузчику — destroy, тег снят, следующий loadAssist — новый тег.
api.destroy();
assert.deepEqual(seen.at(-1), ["destroy"]);
assert.equal(head.children.length, 0);
delete g[WIDGET_GLOBAL]; // так делает настоящий загрузчик на destroy
const again = loadAssist({ siteKey: PK, origin: "https://w.example.com" });
assert.notEqual(again, api);
assert.equal(head.children.length, 1);
again.destroy();
assert.equal(g[WIDGET_GLOBAL], undefined, "заглушка очереди снята");

console.log(
  "npm: подпись/userHash по векторам, тег, очередь, один экземпляр — ок",
);
