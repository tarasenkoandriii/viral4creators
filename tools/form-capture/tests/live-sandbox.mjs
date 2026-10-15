// Opt-in acceptance probe. Never submits or fills the live form.
import { chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
const dir = await mkdtemp(join(tmpdir(), "qa-live-"));
const ext = join(dir, "extension");
await cp(resolve(import.meta.dirname, ".."), ext, {
  recursive: true,
  filter: (p) => !p.includes("/tests"),
});
const manifest = JSON.parse(await readFile(join(ext, "manifest.json"), "utf8"));
const der = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).publicKey.export({ type: "spki", format: "der" });
manifest.key = der.toString("base64");
// Isolated test profile only. Production archive keeps activeTab permissions.
manifest.host_permissions = ["https://sandbox.viral4creators.app/*"];
await writeFile(join(ext, "manifest.json"), JSON.stringify(manifest));
const id = [...createHash("sha256").update(der).digest("hex").slice(0, 32)]
  .map((x) => String.fromCharCode(97 + parseInt(x, 16)))
  .join("");
const context = await chromium.launchPersistentContext(join(dir, "profile"), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  const target = await context.newPage();
  await target.goto("https://sandbox.viral4creators.app/");
  await target.locator("form").first().waitFor();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const snapshot = await popup.evaluate(
    async (tabId) => {
      const { captureFormStructure } = await import("./capture.js");
      return (
        await chrome.scripting.executeScript({
          target: { tabId },
          func: captureFormStructure,
          args: [0],
        })
      )[0].result.snapshot;
    },
    await popup.evaluate(
      async () =>
        (
          await chrome.tabs.query({
            url: "https://sandbox.viral4creators.app/*",
          })
        )[0].id,
    ),
  );
  const baseline = structuredClone(snapshot);
  baseline.fields.find((f) => f.type === "email").required =
    !baseline.fields.find((f) => f.type === "email").required;
  const plan = {
    version: 1,
    source: {
      siteId: "cmv2cbl5m000306lbwoo1svzx",
      standId: "cmv8zxu8j000006kx5jemsngk",
      recordId: "482c8e06-ab5f-42b3-b08a-6e6f5e3135d7",
      recordVersion: 3,
    },
    target: { url: snapshot.url, formIndex: 0, fields: baseline.fields },
    entries: [
      {
        targetId: snapshot.fields.find((f) => f.type === "email").id,
        sourceName: "Email",
        value: "qa@example.com",
      },
    ],
  };
  await popup
    .locator("#transfer-file")
    .setInputFiles({
      name: "plan.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(plan)),
    });
  // Popup test harness keeps target active; invoke the real click handler without foregrounding popup.
  await target.bringToFront();
  await popup.locator("#transfer-preview").evaluate((el) => el.click());
  await popup.locator("#drift-open:enabled").waitFor();
  const opened = context.waitForEvent("page");
  await popup.locator("#drift-open").evaluate((el) => el.click());
  const cabinet = await opened;
  await cabinet.waitForURL("https://assist-app.viral4creators.app/**");
  const url = cabinet.url();
  if (/qa%40|entries|value/.test(url))
    throw new Error("Unexpected data in handoff");
  await writeFile(
    process.argv[2],
    JSON.stringify(
      {
        url,
        snapshot,
        baseline,
        probe:
          "synthetic baseline required flag differs from live sandbox; no live form mutation",
      },
      null,
      2,
    ),
  );
  console.log("Live sandbox extension handoff captured; no form writes");
} finally {
  await context.close();
  await rm(dir, { recursive: true, force: true });
}
