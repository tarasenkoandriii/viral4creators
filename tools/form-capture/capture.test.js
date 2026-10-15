import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { captureFormStructure } from "./capture.js";
import { readFileSync } from "node:fs";
const control = (tag, attrs) => ({
  tagName: tag,
  getAttribute: (k) => attrs[k] ?? null,
  hasAttribute: (k) => Object.hasOwn(attrs, k),
  get value() {
    throw new Error("FIELD VALUE READ");
  },
  get selectedIndex() {
    throw new Error("SELECTION READ");
  },
});
const run = (
  controls,
  index = 0,
  href = "https://example.invalid/user/secret?token=secret#private",
) =>
  JSON.parse(
    JSON.stringify(
      runInNewContext(`(${captureFormStructure.toString()})(${index})`, {
        URL,
        location: { href },
        document: {
          forms: [{ elements: controls }],
          get cookie() {
            throw new Error("COOKIE READ");
          },
        },
        localStorage: new Proxy(
          {},
          {
            get() {
              throw new Error("STORAGE READ");
            },
          },
        ),
      }),
    ),
  );
test("captures constraints without values, cookies, DOM ids or URL path", () => {
  const r = run([
    control("INPUT", { id: "private_email", type: "email", required: "" }),
    control("TEXTAREA", { name: "details", maxlength: "200" }),
    control("INPUT", { id: "csrf", type: "hidden" }),
    control("SELECT", { id: "account" }),
  ]);
  assert.equal(r.snapshot.url, "https://example.invalid/");
  assert.equal(r.snapshot.fields.length, 3);
  assert.ok(r.snapshot.fields.every((f) => /^field_[0-9a-f]{8}$/.test(f.id)));
  assert.ok(!JSON.stringify(r).includes("private_email"));
  assert.ok(!JSON.stringify(r).includes("secret"));
  assert.ok(r.snapshot.fields.some((f) => f.maxLength === 200));
});
test("stable field keys and ordering across DOM rearrangement", () => {
  const a = control("INPUT", { id: "title" }),
    b = control("INPUT", { name: "email", type: "email" });
  assert.deepEqual(run([a, b]).snapshot, run([b, a]).snapshot);
});
test("fails closed for duplicate/missing identity, unsupported radio and oversized forms", () => {
  const a = control("INPUT", { id: "title" });
  for (const fields of [
    [a, a],
    [control("INPUT", {})],
    [control("INPUT", { id: "r", type: "radio" })],
    Array.from({ length: 51 }, (_, i) => control("INPUT", { id: "f" + i })),
  ])
    assert.ok(run(fields).error);
  assert.ok(run([a], 1).error);
  assert.ok(run([a], 0, "http://example.invalid/").error);
});
test("manifest grants only temporary active-tab scripting and no hosts/background", () => {
  const m = JSON.parse(
    readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(m.permissions, ["activeTab", "scripting"]);
  assert.equal(m.host_permissions, undefined);
  assert.equal(m.background, undefined);
  assert.equal(m.web_accessible_resources, undefined);
});
