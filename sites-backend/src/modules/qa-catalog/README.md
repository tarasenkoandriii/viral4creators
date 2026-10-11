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
