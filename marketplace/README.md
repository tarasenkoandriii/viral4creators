# viral4creators · marketplace

Публичная витрина исполнителей — Этап 0 / Фаза 1 маркетплейса. Реализовано
строго по ТЗ на маркетплейс (§9, §19–§21) и ТЗ на бэкенд (§2–§3, §6, §10):
**только** профили Creator/Agency, портфолио, лайки и лёгкий бриф заказчика
без тендера. `Tender`, `Submission`, `Contract`, `Escrow` **сознательно не
реализованы** — по решению §19, отложены до Фазы 2 по измеримому сигналу
спроса (§19.4).

## Что здесь есть

| Страница | Назначение | Вход нужен? |
| --- | --- | --- |
| `/` | Каталог исполнителей, фильтры по нише/бюджету | Нет |
| `/creator/[id]` | Публичный профиль: портфолио, соцсети, лайки | Нет (лайк — да) |
| `/brief` | Форма брифа + мгновенный совет по формату (§21.4) | Да |
| `/brief/[id]` | Подбор исполнителей под бриф, «Связаться» (§21.3) | Да |
| `/become-creator` | Квиз исполнителя (§21.8) | Да |

Пять языков (ru/uk/en/de/es, ТЗ §20 №15) — тот же паттерн, что у `landing/`
(`middleware.ts` + `[locale]`-сегмент + словари `dictionaries/*.json`).
`ru` — дефолт без cookie-выбора, чтобы существующие ссылки не меняли
поведение. `/embed/[id]` и `/feed.xml`/`/feed.json` намеренно вне `[locale]`
(без локали вообще) — см. `lib/i18n.ts` для причин каждого.

Вход — Telegram Login Widget (`NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`), тот же
cookie-контур, что уже использует `admin/` и `frontend/`
(`backend/src/modules/telegram-login`). В отличие от `frontend/`,
маркетплейс не открывается внутри Telegram — это единственный путь входа
здесь, не запасной вариант рядом с `initData`.

## Запуск

Node 24 (`.nvmrc` в корне). Зависимости — строго по `package-lock.json`:

```bash
npm ci
# .env.local (файла-примера нет): NEXT_PUBLIC_TELEGRAM_BOT_USERNAME,
# API_BASE_URL и NEXT_PUBLIC_API_BASE_URL (по умолчанию
# http://localhost:3000/api), NEXT_PUBLIC_SITE_URL
npm run dev                  # порт 3004
```

Бэкенду нужно разрешить этот origin в `CORS_ORIGIN` (см. `backend/.env.example`)
— иначе браузер отклонит куки Telegram-логина при обращении с `credentials: 'include'`.

Проверки — те же, что в CI:

```bash
npm run typecheck            # tsc --noEmit
npm run lint                 # eslint . --max-warnings 0 (ESLint 9, eslint.config.mjs)
npm test                     # scripts/*.test.ts через tsx
npx next build
```

## Явно НЕ реализовано (Фаза 2, по сигналу §19.4)

- Роль Agency, сплит выплат.
- `Tender`/`Submission` — окно приёма заявок, конкурентный выбор.
- `Contract`/`Escrow` («Сейф 5%») — любые деньги на балансе платформы.
- Отзывы с гейтом по оплате (§11.2) — их не может быть без `Contract`.
- Автопубликация портфолио из завершённой сделки (§10) — на Этапе 0
  портфолио пополняется только через self-upload (`sourceType: SELF_UPLOAD`).
- Чат, споры, публичное голосование.

## Что проверяется автоматически, а что — нет

Раздел «Не проверено в этой сборке» (код писался без сети, ни `tsc`, ни
сборка, ни миграция не прогонялись) устарел — по состоянию на 09.10.2026:

- **Версии.** Next 15.5 (ветка `backport`) + React 19 — с захода 12;
  `postcss` закреплён `overrides` (Next 15.5 тянет уязвимый 8.4.31). Линт —
  ESLint 9 с flat config (`eslint.config.mjs`, `next/core-web-vitals`
  через `FlatCompat`) вместо устаревшего `next lint` — с захода 13;
  `fast-glob` плагина `@next/eslint-plugin-next` подменён в `overrides` на
  `tinyglobby` (уходит dev-уязвимость цепочки `braces`).
- **Lockfile.** `package-lock.json` есть с захода 12 — и CI, и Vercel
  ставят ровно его (`npm ci`), а не плавающие версии.
- **CI.** Пакет — строка матрицы `next-apps` в `.github/workflows/ci.yml`
  (джоба запускается, когда меняется `marketplace/`, —
  `scripts/ci-changes.mjs`): `npm ci` → `npm audit --audit-level=high
  --omit=dev` (строгий) → `tsc --noEmit` → `npm run lint` (0 ошибок и 0
  предупреждений) → `npm test` → `next build`.
- **Миграции.** Таблицы маркетплейса живут в схеме бэкенда
  (`backend/prisma/migrations/20261122090000_marketplace_stage0` и
  следующие); джоба `backend` накатывает все миграции на чистый Postgres и
  проверяет, что схема и миграции не разошлись (`prisma migrate diff`).

Руками по-прежнему: оба флоу на стенде с бэкендом (каталог → бриф →
подбор; квиз → появление в каталоге), вход через Telegram Login Widget на
боевом домене и OG-превью — `metadataBase` не задан, `og:image` должен
указывать на боевой домен, а не на `*.vercel.app` (`doc/DEPLOYMENT.md`).
