# GitHub Actions → QA reports (OIDC pilot)

`POST /qa/ci/reports` accepts `{project, report}` with a short-lived GitHub OIDC
Bearer token, audience `viral4creators:qa-report`. It never accepts a cabinet
session, owner API token, caller-selected account/site, catalog edits, or manual
results. Only `schedule` and `workflow_dispatch` on `refs/heads/main`, the exact
workflow path, immutable repository/owner IDs, and GitHub-hosted runners pass.
The report checkout SHA must equal the signed GitHub SHA; deployed SHA remains
report-declared (unknown stays null).

Configure the API's **Production** environment with one explicit pilot binding:

- `QA_CI_REPOSITORY`: `tarasenkoandriii/viral4creators`
- `QA_CI_REPOSITORY_ID`: `1364347018`
- `QA_CI_OWNER_ID`: `177520430`
- `QA_CI_WORKFLOW`: `.github/workflows/sandbox-daily.yml`
- `QA_CI_ACCOUNT_ID` and `QA_CI_SITE_ID`: existing sandbox account/site IDs.

These values are routing/trust configuration, not passwords. Missing binding
fails closed (`503 QA_CI_DISABLED`). Deploy the API before enabling repository
variable `QA_CI_DELIVERY_ENABLED=1`. No permanent CI secret is required. Job-level
`id-token: write` permits obtaining identity; server checks still reject PRs.
Default delivery remains disabled until configured.

A distinct snapshot is created for each Actions run ID, run attempt, and
Playwright project. Cases must already exist with matching versions; CI cannot
silently create/update them. Exact duplicate report delivery reuses the run and
import deduplication. Failed/skipped results stay failed/skipped. Manual acceptance
is a separate run; automated green results do not prove device QA. Delivery errors
fail the step, and the report is still uploaded as an Actions artifact.

GitHub's current and immutable default subject formats are supported; custom
subjects and reusable workflows require a separate policy. Signing keys are
loaded only from the fixed GitHub JWKS endpoint, cached for five minutes;
unknown keys fail closed until refresh. No arbitrary JWT header URLs are used.

Reference: https://docs.github.com/en/actions/reference/security/oidc
