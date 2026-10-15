import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, readFile, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
const source = resolve(import.meta.dirname, "..");
const fixtureUrl =
  "https://capture-fixture.invalid/user/private?token=PRIVATE_TOKEN";
const fixture =
  '<form><label>Email<input id="email" type="email" required value="PRIVATE_EMAIL"></label><label>Password<input id="password" type="password" required value="PRIVATE_PASSWORD"></label><input id="csrf" type="hidden" value="PRIVATE_CSRF"><button>Submit</button></form>';
async function setup(hostAccess) {
  const dir = await mkdtemp(join(tmpdir(), "qa-form-capture-e2e-"));
  const ext = join(dir, "extension");
  await cp(source, ext, {
    recursive: true,
    filter: (p) => !p.includes("/tests"),
  });
  const manifest = JSON.parse(
    await readFile(join(ext, "manifest.json"), "utf8"),
  );
  // Test-only public key makes extension id discoverable without a background worker.
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  manifest.key = der.toString("base64");
  // Synthetic host grant tests the real scripting API, not the production activeTab toolbar gesture.
  if (hostAccess)
    manifest.host_permissions = ["https://capture-fixture.invalid/*"];
  manifest.web_accessible_resources = [
    {
      resources: ["popup.html", "popup.js", "capture.js"],
      matches: ["https://capture-fixture.invalid/*"],
    },
  ];
  await writeFile(join(ext, "manifest.json"), JSON.stringify(manifest));
  const id = [...createHash("sha256").update(der).digest("hex").slice(0, 32)]
    .map((x) => String.fromCharCode(97 + parseInt(x, 16)))
    .join("");
  const context = await chromium.launchPersistentContext(join(dir, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    acceptDownloads: true,
  });
  const network = [];
  await context.route("https://capture-fixture.invalid/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body:
        fixture + `<iframe src="chrome-extension://${id}/popup.html"></iframe>`,
    }),
  );
  context.on("request", (r) => {
    if (
      !r.url().startsWith("chrome-extension:") &&
      !r.url().startsWith("blob:")
    )
      network.push(r.url());
  });
  const target = await context.newPage();
  await target.goto(fixtureUrl);
  const popup = target.frameLocator("iframe");
  return {
    context,
    popup,
    target,
    network,
    close: async () => {
      await context.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("installed extension captures and downloads structure without private values", async ({}, testInfo) => {
  const w = await setup(true);
  try {
    await w.popup
      .getByRole("button", { name: "Собрать снимок", exact: true })
      .click();
    await expect(w.popup.locator("#status")).not.toBeEmpty();
    await expect(
      w.popup.getByRole("button", { name: "Скачать JSON", exact: true }),
      await w.popup.locator("#status").textContent(),
    ).toBeEnabled();
    const preview = await w.popup.locator("#preview").textContent();
    const snapshot = JSON.parse(preview);
    expect(snapshot.url).toBe("https://capture-fixture.invalid/");
    expect(snapshot.fields).toHaveLength(2);
    expect(preview).not.toContain("PRIVATE_");
    const downloadWait = w.target.waitForEvent("download");
    await w.popup
      .getByRole("button", { name: "Скачать JSON", exact: true })
      .click();
    const download = await downloadWait;
    expect(download.suggestedFilename()).toBe("qa-form-snapshot.json");
    expect(JSON.parse(await readFile(await download.path(), "utf8"))).toEqual(
      snapshot,
    );
    await w.target.screenshot({
      path: testInfo.outputPath("extension-capture.png"),
    });
    expect(w.network).toEqual([fixtureUrl]);
    expect(await w.target.locator("#email").inputValue()).toBe("PRIVATE_EMAIL");
  } finally {
    await w.close();
  }
});
test("without a target host grant the installed extension cannot collect or download", async () => {
  const w = await setup(false);
  try {
    await w.popup
      .getByRole("button", { name: "Собрать снимок", exact: true })
      .click();
    await expect(w.popup.locator("#status")).not.toBeEmpty();
    await expect(
      w.popup.getByRole("button", { name: "Скачать JSON", exact: true }),
    ).toBeDisabled();
    await expect(w.popup.locator("#preview")).toBeEmpty();
  } finally {
    await w.close();
  }
});

test("failed recapture clears the previous export and reports the exact form error", async () => {
  const w = await setup(true);
  try {
    await w.popup
      .getByRole("button", { name: "Собрать снимок", exact: true })
      .click();
    await expect(
      w.popup.getByRole("button", { name: "Скачать JSON", exact: true }),
    ).toBeEnabled();
    await w.popup.getByRole("spinbutton").fill("9");
    await w.popup
      .getByRole("button", { name: "Собрать снимок", exact: true })
      .click();
    await expect(w.popup.locator("#status")).toContainText("Форма не найдена");
    await expect(
      w.popup.getByRole("button", { name: "Скачать JSON", exact: true }),
    ).toBeDisabled();
    await expect(w.popup.locator("#preview")).toBeEmpty();
  } finally {
    await w.close();
  }
});
async function planFor(w) {
  await w.popup
    .getByRole("button", { name: "Собрать снимок", exact: true })
    .click();
  await expect(
    w.popup.getByRole("button", { name: "Скачать JSON", exact: true }),
  ).toBeEnabled();
  const snapshot = JSON.parse(await w.popup.locator("#preview").textContent());
  return {
    version: 1,
    source: { standId: "stand", recordId: "record", recordVersion: 1 },
    target: {
      url: "https://capture-fixture.invalid/user/private",
      formIndex: 0,
      fields: snapshot.fields,
    },
    entries: [
      {
        targetId: snapshot.fields.find((f) => f.type === "email").id,
        sourceName: "Email",
        value: "prepared@company.com",
      },
    ],
  };
}
async function importPlan(w, plan) {
  await w.popup
    .getByLabel("План переноса", { exact: true })
    .setInputFiles({
      name: "qa-form-transfer.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(plan)),
    });
  await w.popup
    .getByRole("button", { name: "Сверить и показать изменения", exact: true })
    .click();
}
test("mapped preview is read-only, fill is explicit and never dispatches or submits", async () => {
  const w = await setup(true);
  try {
    await w.target.evaluate(() => {
      window.__events = { input: 0, change: 0, submit: 0 };
      for (const kind of Object.keys(window.__events))
        document.forms[0].addEventListener(kind, (e) => {
          window.__events[kind]++;
          e.preventDefault();
        });
    });
    const plan = await planFor(w);
    await importPlan(w, plan);
    const apply = w.popup.getByRole("button", {
      name: "Заполнить выбранные поля без отправки",
      exact: true,
    });
    await expect(apply).toBeEnabled();
    await expect(w.target.locator("#email")).toHaveValue("PRIVATE_EMAIL");
    await apply.click();
    await expect(w.popup.locator("#transfer-status")).toContainText(
      "Заполнено полей: 1",
    );
    await expect(w.target.locator("#email")).toHaveValue(
      "prepared@company.com",
    );
    await expect(w.target.locator("#password")).toHaveValue("PRIVATE_PASSWORD");
    expect(await w.target.evaluate(() => window.__events)).toEqual({
      input: 0,
      change: 0,
      submit: 0,
    });
    await expect(apply).toBeDisabled();
    await w.popup
      .getByRole("button", {
        name: "Сверить и показать изменения",
        exact: true,
      })
      .click();
    await expect(w.popup.locator("#transfer-status")).toContainText(
      "Изменений: 0",
    );
    await expect(apply).toBeDisabled();
  } finally {
    await w.close();
  }
});
test("editing a value after preview blocks stale fill", async () => {
  const w = await setup(true);
  try {
    await importPlan(w, await planFor(w));
    const apply = w.popup.getByRole("button", {
      name: "Заполнить выбранные поля без отправки",
      exact: true,
    });
    await expect(apply).toBeEnabled();
    await w.target.locator("#email").fill("changed@company.com");
    await apply.click();
    await expect(w.popup.locator("#transfer-status")).toContainText(
      "изменились после предпросмотра",
    );
    await expect(w.target.locator("#email")).toHaveValue("changed@company.com");
  } finally {
    await w.close();
  }
});
test("form drift blocks filling and makes the current snapshot available for QA", async () => {
  const w = await setup(true);
  try {
    await importPlan(w, await planFor(w));
    const apply = w.popup.getByRole("button", {
      name: "Заполнить выбранные поля без отправки",
      exact: true,
    });
    await expect(apply).toBeEnabled();
    await w.target
      .locator("#email")
      .evaluate((el) => el.removeAttribute("required"));
    await apply.click();
    await expect(w.popup.locator("#transfer-status")).toContainText(
      "Структура формы изменилась",
    );
    await expect(w.target.locator("#email")).toHaveValue("PRIVATE_EMAIL");
    await expect(
      w.popup.getByRole("button", { name: "Скачать JSON", exact: true }),
    ).toBeEnabled();
  } finally {
    await w.close();
  }
});
test("credentials, protected targets, duplicate mapping and wrong URLs are rejected", async () => {
  const w = await setup(true);
  try {
    const original = await planFor(w);
    for (const modify of [
      (p) => (p.entries[0].sourceName = "Client Secret"),
      (p) => (p.entries[0].value = "MOCK_KEY_123"),
      (p) =>
        (p.entries[0].targetId = p.target.fields.find(
          (f) => f.type === "password",
        ).id),
      (p) => (p.target.url = "https://other.invalid/user/private"),
      (p) => p.entries.push({ ...p.entries[0] }),
    ]) {
      const plan = structuredClone(original);
      modify(plan);
      await importPlan(w, plan);
      await expect(w.popup.locator("#transfer-status")).not.toBeEmpty();
      await expect(
        w.popup.getByRole("button", {
          name: "Заполнить выбранные поля без отправки",
          exact: true,
        }),
      ).toBeDisabled();
      await expect(w.target.locator("#email")).toHaveValue("PRIVATE_EMAIL");
    }
  } finally {
    await w.close();
  }
});
