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


## Ограниченный автоматический разбор sandbox (21.10.2026)

Существующая доставка CI теперь формирует замечание для **SBX-TUTORIAL v1**, desktop/mobile: пройти шаги, завершить, сбросить. Нового runner, очереди, платных AI-вызовов и миграций нет. Другие кейсы, версии, произвольные клиентские сайты, страницы и роли в этот автоматический разбор не входят.

Условия: прежняя проверка GitHub OIDC и фиксированный кабинет/сайт; metadata.targetOrigin ровно `https://sandbox.viral4creators.app`; у привязанного сайта должен быть действующий подтверждённый HTTPS host. Reporter получает origin из конфигурации Playwright, не из текста ошибки. Origin входит в хеш отчёта; отсутствие поля допускается для старых отчётов, но не разрешает создание sandbox-замечания. Локальный запуск не считается проверкой production.

После сохранения отчёта API читает реальные attempts по account/run/case/project/reportHash. Первая failed-попытка даёт `needs_confirmation`, P2, ссылку на сохранённую попытку. Это наблюдение о сбое проверки, не установленная причина дефекта. Дедупликация использует постоянные сценарий/версию/проект и существующий уникальный fingerprint. Повторная доставка, новый CI run и конкурентная доставка не создают второе такое замечание. Частично завершённую доставку можно повторить: отчёт replayed, недостающее замечание достраивается.

Повторная проверка возвращает последнюю сохранённую попытку и reportHash. Успех после ошибки отмечается flaky; общий неуспешный runner блокирует приёмку. Статусы, содержимое, ручное подтверждение и закрытие существующего замечания автоматически не меняются. После ручного закрытия повторная ошибка по тому же сценарию указывает на исходное замечание и требует разбора; автоматического reopen нет.

`test-results/qa-delivery.json` содержит только подтверждённый runId, findingId, attemptId, reportHash и результат. Он попадает в уже существующий Actions artifact на 14 дней. Сырые ответы API, URL с query, токены, текст ошибок и снимки в квитанцию не включаются. Доказательство этого этапа — запись попытки; автоматическая загрузка private PNG и расширение на несколько URL/состояний/ролей остаются отдельными задачами.

При выкладке сначала API, затем следующий штатный sandbox workflow: старые отчёты продолжают импортироваться. Не запускать schedule вручную ради проверки этого изменения: в полном workflow есть отдельно включаемые платные голосовые проверки. Регрессия разбора проверяется локально на фикстурах, браузерный сценарий — без ключей и доставки в production.

## Сохранённая перепроверка в карточке замечания

`GET /qa/sites/:siteId/findings/:id` добавляет `recheck` (либо null для ручного источника/отсутствия сопоставимой новой попытки). Доступ остаётся read-only, включая viewer. Проекция читает до 100 последних автоматических attempts того же account/site/case/project и сравнивает snapshot version, source и targetOrigin. Порядок определяется началом отчёта; поздняя доставка старой проверки не повышает её над свежей. Повторная попытка внутри того же отчёта также может быть квитанцией.

Карточка показывает сохранённый результат, recordedStatus/runnerStatus, caseVersion/project, runId/attemptId, SHA-256 отчёта, SHA тестов и известный SHA деплоя. Отсутствие SHA деплоя явно обозначается. Passed при неизвестном или неуспешном runner становится blocked. «Обновить сохранённый результат» только перечитывает detail, не запускает CI и не создаёт замечаний. Квитанция включена в MD отдельного замечания и через общий текст отчёта — в сводные MD/PDF. Финальная сверка экспорта отслеживает изменение квитанции даже без изменения ручной ревизии.

Это доказательство результата ограниченного сценария, не подтверждение причины/исправления и не ручное закрытие. Статус, ревизия, история и ручная verification не изменяются. Старый API без recheck совместим с новым клиентом. Расширение runner на несколько страниц/состояний/ролей, автоматические приватные PNG и штатная production-приёмка остаются открытыми.

### Штатный цикл 21.10.2026 (только чтение)

Существующий `schedule` run [39596082413](https://github.com/tarasenkoandriii/viral4creators/actions/runs/39596082413) на `102a726f8f2c7ba2f0f8fac7b9378431c2461974` завершился success; artifact `sandbox-qa-report` содержит оба серверных receipts. Отчёты пересчитаны настоящим `parseQaReport`: desktop `bfd6fd0e9b662152bfeb46af08276cecd9c9e274cef3c895618667d49d2c4523`, mobile `2ef0b27fda600fc354e06d5241dbd2d0444ae1184384f47c54cbf86fd6a8ca10`. Сохранённые runId/attemptId присутствуют; `audit.status=passed`, `flaky=false`, `findingId=null`, `created=false`. SBX-TUTORIAL v1 passed без retry; targetOrigin — точный sandbox, deployedSha неизвестен (null). Платная Soniox job skipped. Общий отчёт incomplete из-за двух ручных физических кейсов not-run; workflow success не равен приёмке этих кейсов.

Это подтверждение штатной bounded CI-доставки. Оно не подтверждает production failure → finding → recheck (ошибки не было), новый UI или SHA production-сборки. Новый workflow не запускался; записи в production не создавались этим аудитом, исходные отчёты были ранее сохранены штатным CI.
