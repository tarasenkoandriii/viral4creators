const clone = (value) => JSON.parse(JSON.stringify(value));
const STATUSES = new Set(["passed", "failed", "skipped", "blocked", "not-run"]);
function createRun(catalog, metadata = {}) {
  const seen = new Set();
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.cases))
    throw new Error("Invalid catalog");
  for (const item of catalog.cases) {
    if (
      !/^[A-Z][A-Z0-9-]{1,63}$/.test(item.id) ||
      seen.has(item.id) ||
      !Number.isInteger(item.version) ||
      item.version < 1 ||
      !["manual", "automated"].includes(item.type) ||
      !Array.isArray(item.projects) ||
      !item.projects.length ||
      new Set(item.projects).size !== item.projects.length ||
      !Array.isArray(item.steps) ||
      !item.steps.length ||
      item.steps.some((step) => typeof step !== "string" || !step.trim())
    )
      throw new Error("Invalid case");
    seen.add(item.id);
  }
  return {
    schemaVersion: 1,
    projectId: catalog.projectId,
    metadata: clone(metadata),
    cases: clone(catalog.cases),
    results: [],
    unknownTests: 0,
  };
}
function recordAttempt(
  run,
  {
    caseId,
    project,
    attempt,
    status,
    durationMs = 0,
    origin = "automated",
    stepStatuses,
  },
) {
  const item = run.cases.find((item) => item.id === caseId);
  if (!item || !item.projects.includes(project)) return false;
  if (
    origin !== item.type ||
    !STATUSES.has(status) ||
    !Number.isInteger(attempt) ||
    attempt < 0 ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  )
    throw new Error("Invalid attempt");
  if (
    origin === "manual" &&
    status === "passed" &&
    (!Array.isArray(stepStatuses) ||
      stepStatuses.length !== item.steps.length ||
      stepStatuses.some((step) => step !== "passed"))
  )
    throw new Error("Incomplete manual steps");
  const result = {
    caseId,
    caseVersion: item.version,
    project,
    attempt,
    status,
    durationMs,
    origin,
    ...(origin === "manual" ? { stepStatuses: clone(stepStatuses || []) } : {}),
  };
  const existing = run.results.find(
    (row) =>
      row.caseId === caseId &&
      row.project === project &&
      row.attempt === attempt,
  );
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(result))
      throw new Error("Conflicting attempt");
    return true;
  }
  run.results.push(result);
  return true;
}
function summary(run) {
  const cells = run.cases.flatMap((item) =>
    item.projects.map((project) => {
      const attempts = run.results
        .filter((row) => row.caseId === item.id && row.project === project)
        .sort((a, b) => a.attempt - b.attempt);
      return {
        caseId: item.id,
        caseVersion: item.version,
        project,
        type: item.type,
        required: item.required !== false,
        status: attempts.at(-1)?.status || "not-run",
        flaky:
          attempts.at(-1)?.status === "passed" &&
          attempts.some((row) => row.status === "failed"),
        attempts,
      };
    }),
  );
  const outcome = (items) =>
    items.some((item) => item.status === "failed")
      ? "failed"
      : items.some((item) => item.required && item.status !== "passed")
        ? "incomplete"
        : items.length
          ? "passed"
          : "not-run";
  return {
    cells,
    status:
      run.unknownTests && outcome(cells) === "passed"
        ? "incomplete"
        : outcome(cells),
    automatedStatus: outcome(cells.filter((item) => item.type === "automated")),
    manualStatus: outcome(cells.filter((item) => item.type === "manual")),
    counts: Object.fromEntries(
      [...STATUSES].map((status) => [
        status,
        cells.filter((item) => item.status === status).length,
      ]),
    ),
    unknownTests: run.unknownTests,
  };
}
module.exports = { createRun, recordAttempt, summary };
