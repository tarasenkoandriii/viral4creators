const fs = require("node:fs");
const path = require("node:path");
const { createRun, recordAttempt, summary } = require("./run-model.cjs");
const catalog = require("./catalog.json");
class QaReporter {
  constructor(options = {}) {
    this.outputFile =
      options.outputFile ||
      path.resolve(__dirname, "../test-results/qa-run.json");
  }
  onBegin() {
    const sha = (value) => (/^[a-f0-9]{40}$/i.test(value || "") ? value : null);
    this.run = createRun(catalog, {
      source: "playwright",
      startedAt: new Date().toISOString(),
      testSourceSha: sha(process.env.GITHUB_SHA),
      // The CI checkout is not proof of what is deployed.
      deployedSha: sha(process.env.QA_DEPLOYED_SHA),
    });
  }
  onTestEnd(test, result) {
    const id = /^\[([A-Z0-9-]+)\]/.exec(test.title)?.[1];
    const item = this.run.cases.find((item) => item.id === id);
    const project = test.parent.project()?.name || "unknown";
    if (!item) {
      this.run.unknownTests++;
      return;
    }
    // Paid desktop-only cases also appear as intentionally skipped mobile tests.
    if (!item.projects.includes(project)) {
      if (result.status !== "skipped") this.run.unknownTests++;
      return;
    }
    recordAttempt(this.run, {
      caseId: id,
      project,
      attempt: result.retry,
      status:
        result.status === "passed" || result.status === "skipped"
          ? result.status
          : result.status === "interrupted"
            ? "blocked"
            : "failed",
      durationMs: result.duration,
    });
  }
  onEnd(result) {
    const report = {
      ...this.run,
      runnerStatus: result.status,
      summary: summary(this.run),
    };
    if (result.status !== "passed" && report.summary.status === "passed")
      report.summary.status = "incomplete";
    const dir = path.dirname(this.outputFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.outputFile, JSON.stringify(report, null, 2) + "\n");
  }
}
module.exports = QaReporter;
