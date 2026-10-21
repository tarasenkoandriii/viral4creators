# ADM — вкладка «FFmpeg: обработка» (ТЗ v1.1 §13.1)

## Файлы
- admin/src/app/ffmpeg/page.tsx — страница (Suspense, фильтры в URL, `?job=`, диалоги, автообновление)
- admin/src/app/ffmpeg/OverviewPanel.tsx, JobsPanel.tsx, JobCard.tsx, LimitsPanel.tsx, ActionDialog.tsx, ui.tsx, usePoll.ts
- admin/src/lib/ffmpeg.ts — запросы (AbortSignal, тайм-ауты), разбор снимков BE, фильтры, тексты, сверка мутаций
- admin/src/lib/ffmpeg.test.ts — юнит-тест (входит в npm test)
- admin/src/lib/types.ts — раздел FFmpeg (модель экрана)
- admin/src/lib/nav.ts — пункт «FFmpeg: обработка» в «Эксплуатации»; admin/src/lib/nav.test.ts — 36 ссылок, единственность /ffmpeg
- E2E (вне репо): /tmp/ff-ADM/e2e.cjs, лог /tmp/ff-ADM/e2e.log

## Проверки
tsc --noEmit ✓; npm run lint (max-warnings 0) ✓; npm test ✓ (11 файлов); next build ✓ (/ffmpeg 29.4 kB);
Playwright на собранной админке с моком BE: 23/23 ✓; axe 0 нарушений на 320/1280 × light/dark
(единственное — `region` у `.admin-topbar-title` общей шапки AdminNav, есть и на /cron, вне пакета).

## Решения
- Р-FF-ADM-1 Контракт — фактические DTO BE (backend/src/modules/ffmpeg-admin), а не черновой из брифа:
  `operationId` (UUID) вместо `requestId`; download-link `{operationId, file}`; purge `confirmIrreversible: true`;
  reconcile только `{operationId}`; фильтры `period` (24h/7d/30d/90d) и `clientOperationId`; ответы — снимки
  `{state, fetchedAt, error, data}` с сырыми ops-данными (snake_case), мутации — `MutationOutcome`.
- Р-FF-ADM-2 Свой fetch-слой в lib/ffmpeg.ts (AbortSignal, тайм-аут GET 12 с / мутации 15 с), конверт и ApiRequestError общие; admin-api.ts не тронут.
- Р-FF-ADM-3 Неизвестный исход (сеть, тайм-аут, 5xx, `outcome: unknown` при 200) — то же тело/ключ ещё 3 раза (2/5/10 с), затем «результат неизвестен» и «Сверить ещё раз» тем же ключом. Ключ меняется только после окончательного 4xx (BE пишет отказ под ключом и на повтор вернёт его же).
- Р-FF-ADM-4 «Эксплуатация» — 7 пунктов (ТЗ требует эту группу); в nav.test исключение ≤7 только для ops.
- Р-FF-ADM-5 CPU/RAM executor ops-overview не отдаёт — плитка «нет данных: сервер не сообщает», не ноль.
- Р-FF-ADM-6 Результаты: ссылка только по нажатию; предпросмотр только растр/видео/аудио по MIME сервера, preload=none, без autoplay; SVG/HTML — только скачивание; скачивание через временный <a>, ссылка не остаётся в DOM.
- Р-FF-ADM-7 Второй рубеж приватности: URL/токены/Bearer вычищаются из stderr, timeline, сообщений; имена-URL/пути скрываются; stderr ≤64 KiB (хвост).
- Р-FF-ADM-8 Кнопки не скрываются по правам (сервер решает, 403 → текст с правом ffmpeg.*); права из overview.permissions показаны текстом.
- Р-FF-ADM-9 Админка только тёмная (globals.css color-scheme: dark); «обе темы» проверены эмуляцией prefers-color-scheme — светлую тему одной вкладке не добавлял.

## Не сделано / для других пакетов
- Очередь внимания: в backend admin-attention нет правила FFmpeg (не мой пакет). Страница принимает `?state=&jobId=&operationId=&job=`; хелпер `ffmpegHref(filters, jobId)` в lib/ffmpeg.ts. Подпись кнопки — `ACTION_LABEL` в lib/attention.ts (не мой файл).
- BE: у reconcile/download-link в DTO нет `reason` (ТЗ: причина у каждой мутации) — UI её не шлёт (иначе 400 forbidNonWhitelisted).
- BE: повтор операции в фазе `requested`/`unknown` возвращает `unknown` без пересверки — цикл сверки UI до исхода не дойдёт; стоит пересверять по ключу.
- CORE: ops-overview без CPU/RAM executor.
- AdminNav: обернуть мобильную шапку в <header> (axe region).

## Доработка по обновлённому контракту (свой сервер основной, hosted — fallback)
- Сводка: «основной: свой сервер, запасной: внешний сервис» (`routingSchemeText`), плитка «Запасной путь и breaker» (открыт/закрыт, до какого времени, отказов N из порога, fallback вкл/выкл), «Ушло к внешнему сервису за 24 ч» (`fallbacks24h`; null → «нет данных»).
- CPU/RAM executor из `executor.resources`: CPU % (из 200%), RSS, пик, время замера; idle — «простой», stale — пометка.
- Recovery: «Продолжить после сверки…» → отдельный диалог (отметка «очередь сверена с продуктовой БД» + обязательная причина, право configure) → `reconciled: true`; `NOT_RECONCILED` / `FFMPEG_REASON_REQUIRED` — понятный текст.
- Очередь внимания: `ACTION_LABEL` для 5 видов `ffmpeg-*` → «Открыть FFmpeg» (lib/attention.ts); тест сверяет виды с backend attention-rules.ts и разбор их адресов в фильтры.
- reconcile и download-link передают необязательную причину, если введена.
- AdminNav: мобильная шапка `<div>` → `<header>` — axe `region` снят.
- Р-FF-ADM-10 Бейджи вкладки переносят длинные подписи (на 320px nowrap давал 7px прокрутки).
Проверки: tsc ✓, lint ✓, npm test ✓, next build ✓, Playwright 26/26 ✓, axe 0 на 320/1280 × light/dark (включая breaker+recovery).
