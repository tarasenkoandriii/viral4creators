const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Reporter = require("./playwright-reporter.cjs");
test("reporter stores case IDs and retries while excluding error bodies and traces", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-reporter-"));
  try {
    const outputFile = path.join(dir, "run.json"),
      reporter = new Reporter({ outputFile });
    reporter.onBegin();
    const item = {
      title: "[SBX-LOGIN] Login",
      parent: { project: () => ({ name: "desktop" }) },
    };
    reporter.onTestEnd(item, {
      retry: 0,
      status: "failed",
      duration: 1,
      error: { message: "PRIVATE_API_TOKEN" },
      attachments: [{ body: "PRIVATE_AUDIO" }],
    });
    reporter.onTestEnd(item, { retry: 1, status: "passed", duration: 2 });
    reporter.onEnd({ status: "passed" });
    const text = fs.readFileSync(outputFile, "utf8"),
      data = JSON.parse(text);
    assert.equal(data.results.length, 2);
    assert.equal(data.summary.cells[0].flaky, true);
    assert.equal(data.summary.status, "incomplete");
    assert.equal(text.includes("PRIVATE_API_TOKEN"), false);
    assert.equal(text.includes("PRIVATE_AUDIO"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("a test absent from the catalog is visible as unmapped", () => {
  const reporter = new Reporter();
  reporter.onBegin();
  reporter.onTestEnd(
    { title: "New case", parent: { project: () => ({ name: "desktop" }) } },
    { retry: 0, status: "passed", duration: 1 },
  );
  assert.equal(reporter.run.unknownTests, 1);
});
