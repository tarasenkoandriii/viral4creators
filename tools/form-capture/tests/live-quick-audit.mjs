// Opt-in read-only check of Q against our public sandbox. No form submissions.
// Host grant exists only in a temporary test profile; this does NOT prove toolbar activeTab.
import { chromium, expect } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
const output = process.argv[2];
if (!output) throw new Error("Provide output JSON path");
const dir = await mkdtemp(join(tmpdir(), "qa-024-sandbox-"));
const extension = join(dir, "extension");
await cp(resolve(import.meta.dirname, ".."), extension, {
  recursive: true,
  filter: (p) => !p.includes("/tests"),
});
const manifest = JSON.parse(
  await readFile(join(extension, "manifest.json"), "utf8"),
);
if (
  manifest.version !== "0.2.4" ||
  manifest.host_permissions ||
  JSON.stringify(manifest.permissions) !==
    JSON.stringify(["activeTab", "scripting"])
)
  throw new Error("Unexpected production permissions/version");
const der = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).publicKey.export({ type: "spki", format: "der" });
manifest.key = der.toString("base64");
manifest.host_permissions = ["https://sandbox.viral4creators.app/*"];
await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
const id = [...createHash("sha256").update(der).digest("hex").slice(0, 32)]
  .map((x) => String.fromCharCode(97 + parseInt(x, 16)))
  .join("");
const context = await chromium.launchPersistentContext(join(dir, "profile"), {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
  acceptDownloads: true,
});
try {
  const target = await context.newPage();
  await target.goto("https://sandbox.viral4creators.app/?qa-check=20261020");
  await target.locator("form").first().waitFor();
  const initial = await target
    .locator("form input,form textarea,form select")
    .evaluateAll((es) =>
      es.map((e) => ({ value: e.value, checked: e.checked })),
    );
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const { tabId, version } = await popup.evaluate(async () => ({
    tabId: (
      await chrome.tabs.query({ url: "https://sandbox.viral4creators.app/*" })
    )[0].id,
    version: chrome.runtime.getManifest().version,
  }));
  const requests = [];
  context.on("request", (r) => {
    if (
      !r.url().startsWith("blob:") &&
      !r.url().startsWith("chrome-extension:")
    )
      requests.push(
        r.method() + " " + new URL(r.url()).origin + new URL(r.url()).pathname,
      );
  });
  await popup.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["workbench.js"],
      }),
    tabId,
  );
  const panel = target.locator("#qa-form-structure-workbench");
  await expect(panel).toHaveCount(1);
  await expect(
    panel.getByRole("heading", {
      name: "QA Form Capture · 0.2.4",
      exact: true,
    }),
  ).toBeVisible();
  await panel.locator("#audit").click();
  const report = await panel.locator("#audit-result").innerText();
  expect(report).toContain("https://sandbox.viral4creators.app");
  expect(report).not.toContain("qa-check");
  expect(report).not.toContain("demo@example.test");
  expect(report).not.toContain("SandboxDemo123");
  expect(report).toContain("Поля без очевидной подписи: сигнал не найден");
  const downloadPromise = target.waitForEvent("download");
  await panel.locator("#audit-download").click();
  const download = await downloadPromise;
  expect(await readFile(await download.path(), "utf8")).toBe(report);
  await panel.locator("#audit").click();
  await popup.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["workbench.js"],
      }),
    tabId,
  );
  await expect(panel).toHaveCount(1);
  expect(
    await target
      .locator("form input,form textarea,form select")
      .evaluateAll((es) =>
        es.map((e) => ({ value: e.value, checked: e.checked })),
      ),
  ).toEqual(initial);
  await expect(
    target.getByText("Принято заявок в этой вкладке: 0", { exact: true }),
  ).toBeVisible();
  expect(requests).toEqual([]);
  await target.screenshot({
    path: output.replace(/\.json$/, ".png"),
    fullPage: true,
  });
  await writeFile(output.replace(/\.json$/, ".md"), report);
  await writeFile(
    output,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        version,
        origin: "https://sandbox.viral4creators.app",
        permissionProbe:
          "temporary isolated test-profile host grant; NOT real toolbar activeTab",
        panels: 1,
        repeatSafe: true,
        formValuesUnchanged: true,
        submissions: 0,
        requestsDuringAudit: requests,
        reportDownloaded: true,
        qaEntitiesCreated: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    "Sandbox Q 0.2.4: report/download/repeat/single panel/unchanged fields/zero submissions/zero audit requests PASS; toolbar activeTab not certified",
  );
} finally {
  await context.close();
  await rm(dir, { recursive: true, force: true });
}
