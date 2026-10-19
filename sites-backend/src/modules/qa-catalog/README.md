# QA catalog API

Все маршруты требуют проверенную идентичность, членство аккаунта и `qa` role. `qa=viewer` читает; `qa=admin` пишет; владелец аккаунта имеет оба права. Право assist не заменяет qa. Заголовок выбора кабинета и сессия — штатные механизмы site-core. Сайт чужого аккаунта и чужой кейс возвращают одинаковый 404.

- GET /qa/sites/:siteId/cases — страница до 100 heads, включая архив; `{items,nextAfterKey}`, следующий запрос `?after=KEY`.
- POST /qa/sites/:siteId/cases — `{caseKey, payload}`.
- GET /qa/sites/:siteId/cases/:id — head и current revision.
- PUT /qa/sites/:siteId/cases/:id — `{expectedVersion, payload}`; полный snapshot, 409 при stale version.
- GET /qa/sites/:siteId/cases/:id/history — страница до 100 immutable revisions; `{items,nextBeforeVersion}`, следующий запрос `?before=VERSION`.

Payload:

```json
{"title":"Login","purpose":"Check invalid password","preconditions":"Owned sandbox, demo account","steps":[{"action":"Submit invalid password","expected":"Login rejected"}],"type":"manual","priority":"high","tags":["login"],"requirementIds":["QA-LOGIN"],"archived":false}
```

caseKey — стабильный uppercase ID, например SBX-LOGIN, не изменяется через PUT. Поля tenant/member и version приходят от сервера. Текст не выполняется как код и не отправляется ИИ. Архивировать и восстановить можно новым PUT с соответствующим archived; старая revision остаётся. Создание head и первой revision, а также CAS-замена head и новая revision выполняются транзакцией. Восстановление старого snapshot через новый PUT тоже создаёт новую version.

Размер нормализованного payload ≤64 KiB, title ≤200, 1–100 шагов, action/expected ≤2000, tags/requirements ≤20 элементов. Не хранить пароли или записи посетителей в шагах. Серверный модуль не даёт публичного доступа к артефактам и не запускает CI.

Backend связан с редактором кейсов и запусков в assist (`QaCatalogScreen`, `QaRunsScreen`). Доступность production storage требует применения additive migration 20261013090000_qa_catalog; наличие кода не подтверждает состояние миграции на конкретной базе. Авторизация и optimistic concurrency проверяются unit-тестами; миграционную совместимость проверяет schema job CI.


## Stored runs (manual result API)

- POST /qa/sites/:siteId/runs — `{title,caseIds}`, 1–100 unique existing unarchived cases in this site's tenant. Freezes IDs, keys, versions and complete payloads; ≤1 MiB snapshot.
- GET /qa/sites/:siteId/runs — 50 headers, `?before=ID`, nextBeforeId.
- GET /qa/sites/:siteId/runs/:id — frozen snapshot, revision, latestAttempts, counts (including notRun) and flakyCaseKeys (passed after a recorded failure).
- GET /qa/sites/:siteId/runs/:id/attempts — append-only history, 100 rows, `?before=ID`, nextBeforeId.
- POST /qa/sites/:siteId/runs/:id/attempts — `{expectedRevision,caseKey,status,comment}`. Manual cases only; status passed/failed/blocked/skipped. Non-passing results require an explanation (comment ≤4000 chars). Member attribution and attemptNumber are server-owned. A stale revision returns QA_RUN_CONFLICT/409 without creating an attempt.

Runs use the same QA read/write roles and tenant isolation. Head CAS and appended attempt commit in one transaction. Old failures are retained; complete means all cases have an executed passed/failed result, not overall success. Blocked/skipped/notRun never become passed. The endpoint records a human declaration; it does not certify physical-device acceptance or execute tests. Automated cases remain notRun until a validated report is imported. QaRunService.importReport validates the report against the frozen run snapshot and appends results transactionally. The assist run editor is implemented. The CI pilot uses QaCiService with GitHub identity and explicit repository/workflow/account/site bindings; report source SHA must match the authenticated claim and case versions must match the catalog. Unconfigured CI delivery is disabled. These services record supplied results; they do not themselves execute browser tests or implement AI layout/logic audits, repository fixes, or CI audits.

## Acceptance and finding provenance (19.10.2026)

An automated `passed` attempt whose `sourceMetadata.runnerStatus` is not `passed` contributes `blocked` to acceptance summaries and the external evidence reader. The stored result and report metadata remain unchanged. Evidence reads use one RepeatableRead transaction. CI re-delivery uses the existing immutable run snapshot even when the catalog later changes; a fresh run still validates current catalog versions.

Finding payloads optionally accept `source: {runId, caseKey, attemptId}`. All three fields are required together. Create/replace validates the run in the same account and site, the case in its frozen snapshot, and the exact saved attempt in the same transaction before writing. A foreign/missing reference returns `QA_FINDING_SOURCE_INVALID` without revealing which part exists. The reference is retained in immutable finding revisions and the fix prompt; legacy payloads need no source. This is provenance, not automatic proof that a defect is fixed. Evidence strings remain descriptions/links; no upload endpoint is implied.

## Private evidence

`GET/POST /qa/sites/:siteId/findings/:findingId/artifacts`, `GET .../artifacts/:id/download`, `DELETE .../artifacts/:id`. QA_READ reads; QA_WRITE uploads/deletes. The service repeats the permission/site/finding checks. Upload JSON is `{requestId: UUIDv4, contentType:"image/png", contentBase64, redacted:true}`. Up to 2 MiB, non-interlaced 8-bit RGB/RGBA/gray PNG only. Signature, CRC, dimensions, inflated size and scanline filters are checked; ancillary chunks are removed. SHA-256 describes stored bytes. Filename and original metadata are not stored. The record pins `findingRevision`; PostgreSQL compound FKs enforce tenant and revision ownership.

Private storage uses the existing private Blob configuration. Upload reservation and quota checks serialize on the account row (10 per finding, 1000 files and 100 MiB per account). The same UUID/content replays; an unfinished upload cannot be submitted twice. A lost DB acknowledgment is reconciled before compensating. Pending reservations expire after 15 minutes; ready files are readable for 30 days. A download link lives at most five minutes and never beyond expiry. Signed links are bearer credentials: share only with authorized QA participants. `GET /cron/qa-artifact-retention` requires CRON_SECRET and runs every 15 minutes. Cleanup deletes private bytes before DB rows; deletion errors and a bounded-batch backlog return 503 and preserve retryable tracking. Removing a file does not rewrite old finding revisions.

## Plans and catalog workbench

`GET/POST /qa/sites/:siteId/plans`; `GET/PUT .../plans/:id`; `GET .../plans/:id/history`; `POST .../plans/:id/runs`. Plan keys and payloads are bounded. The server freezes current unarchived case revisions into each immutable plan version. PUT uses expectedVersion/CAS. Environment matrix: up to 12 named browser/device/viewport/theme/locale descriptions. An optional assignee must belong to this account and have QA read access; assignment never grants permissions. Archived plans cannot create new runs. A start request supplies `{expectedVersion,environmentIndex,requestId}` and freezes the exact plan revision/environment into a new notRun run. Replaying the same request returns the same run, including after a later plan edit; changing its version or environment conflicts. Creating a run does not execute a browser, authenticate a device or call a paid provider.

`GET /qa/sites/:siteId/inventory?search=...` returns up to 100 non-archived current case revisions, bounded to 1 MiB; truncated is explicit. `POST .../inventory/import` accepts `{cases:[{caseKey,payload}]}` (up to 100/512 KiB). Conflicting keys abort the entire transaction. The same original batch replays without overwriting subsequent case edits. The client provides a UTF-8 comma-separated RFC4180 CSV preview and export, including multiline fields and formula defanging. Requirement links are computed over this inventory selection; they are neither a complete requirements registry nor evidence of acceptance.
