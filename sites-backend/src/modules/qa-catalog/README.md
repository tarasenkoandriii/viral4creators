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

Это backend редактора; frontend, сохранение plans/runs и связка локального pilot reporter с БД ещё не подключены. Production storage станет доступно только после применения additive migration 20261013090000_qa_catalog. Авторизация и optimistic concurrency проверяются unit-тестами; миграционную совместимость проверяет schema job CI.


## Stored runs (manual result API)

- POST /qa/sites/:siteId/runs — `{title,caseIds}`, 1–100 unique existing unarchived cases in this site's tenant. Freezes IDs, keys, versions and complete payloads; ≤1 MiB snapshot.
- GET /qa/sites/:siteId/runs — 50 headers, `?before=ID`, nextBeforeId.
- GET /qa/sites/:siteId/runs/:id — frozen snapshot, revision, latestAttempts, counts (including notRun) and flakyCaseKeys (passed after a recorded failure).
- GET /qa/sites/:siteId/runs/:id/attempts — append-only history, 100 rows, `?before=ID`, nextBeforeId.
- POST /qa/sites/:siteId/runs/:id/attempts — `{expectedRevision,caseKey,status,comment}`. Manual cases only; status passed/failed/blocked/skipped. Non-passing results require an explanation (comment ≤4000 chars). Member attribution and attemptNumber are server-owned. A stale revision returns QA_RUN_CONFLICT/409 without creating an attempt.

Runs use the same QA read/write roles and tenant isolation. Head CAS and appended attempt commit in one transaction. Old failures are retained; complete means all cases have an executed passed/failed result, not overall success. Blocked/skipped/notRun never become passed. The endpoint records a human declaration; it does not certify physical-device acceptance or execute tests. Automated case results remain notRun until a separately authenticated reporter is implemented. No run editor, close/finalize action, report ingestion, artifact upload, or execution worker is added in this delivery.
