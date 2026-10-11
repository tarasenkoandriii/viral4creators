const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRun, recordAttempt, summary } = require("./run-model.cjs");
const catalog = () => ({
  schemaVersion: 1,
  projectId: "owned",
  cases: [
    {
      id: "QA-AUTO",
      version: 1,
      type: "automated",
      required: true,
      projects: ["desktop"],
      steps: ["Check form"],
    },
    {
      id: "QA-MANUAL",
      version: 1,
      type: "manual",
      required: true,
      projects: ["ios"],
      steps: ["Check microphone", "Cancel action"],
    },
  ],
});
const automatic = (run, status = "passed", attempt = 0) =>
  recordAttempt(run, {
    caseId: "QA-AUTO",
    project: "desktop",
    attempt,
    status,
  });
test("snapshot preserves version and steps after catalog changes", () => {
  const source = catalog(),
    run = createRun(source);
  source.cases[0].version = 2;
  source.cases[0].steps[0] = "Changed";
  automatic(run);
  assert.equal(run.results[0].caseVersion, 1);
  assert.equal(run.cases[0].steps[0], "Check form");
});
test("green automated run leaves required manual acceptance incomplete", () => {
  const run = createRun(catalog());
  automatic(run);
  const result = summary(run);
  assert.equal(result.automatedStatus, "passed");
  assert.equal(result.status, "incomplete");
  assert.equal(result.manualStatus, "incomplete");
});
test("retry preserves initial failure and reports flaky without duplicate delivery", () => {
  const run = createRun(catalog());
  automatic(run, "failed");
  automatic(run, "passed", 1);
  automatic(run, "passed", 1);
  const result = summary(run);
  assert.equal(run.results.length, 2);
  assert.equal(result.cells[0].flaky, true);
  assert.throws(() => automatic(run, "failed", 1), /Conflicting/);
});
test("missing or skipped required test cannot pass", () => {
  const run = createRun(catalog());
  assert.equal(summary(run).automatedStatus, "incomplete");
  automatic(run, "skipped");
  assert.equal(summary(run).automatedStatus, "incomplete");
  assert.equal(summary(run).counts.skipped, 1);
});
test("manual pass requires all steps and cannot overwrite automated result", () => {
  const run = createRun(catalog());
  const data = {
    caseId: "QA-MANUAL",
    project: "ios",
    attempt: 0,
    status: "passed",
    origin: "manual",
  };
  assert.throws(() => recordAttempt(run, data), /Incomplete/);
  assert.throws(
    () => recordAttempt(run, { ...data, stepStatuses: ["passed", "not-run"] }),
    /Incomplete/,
  );
  recordAttempt(run, { ...data, stepStatuses: ["passed", "passed"] });
  automatic(run);
  assert.equal(summary(run).status, "passed");
  assert.throws(
    () =>
      recordAttempt(run, {
        caseId: "QA-AUTO",
        project: "desktop",
        attempt: 1,
        status: "passed",
        origin: "manual",
      }),
    /Invalid/,
  );
});
test("invalid catalog and unknown project do not silently create cases", () => {
  const source = catalog();
  source.cases.push(source.cases[0]);
  assert.throws(() => createRun(source), /Invalid case/);
  const run = createRun(catalog());
  assert.equal(
    recordAttempt(run, {
      caseId: "MISSING",
      project: "desktop",
      attempt: 0,
      status: "passed",
    }),
    false,
  );
  assert.equal(
    recordAttempt(run, {
      caseId: "QA-AUTO",
      project: "other",
      attempt: 0,
      status: "passed",
    }),
    false,
  );
});
test("unknown mappings never hide a known failure", () => {
  const run = createRun(catalog());
  automatic(run, "failed");
  run.unknownTests = 1;
  assert.equal(summary(run).status, "failed");
});
