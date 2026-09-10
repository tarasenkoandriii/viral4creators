# Сессии на Supabase Postgres через Prisma

Заменяет in-memory `SessionService` (обычный `Map` в памяти процесса) —
подробно, почему это было нужно, см. `VERCEL-READINESS-AUDIT.md`,
находка №2. Схема и сам сервис — `backend/prisma/schema.prisma` и
`backend/src/common/session.service.ts`.

## Важное ограничение, о котором нужно знать сразу

В песочнице, где это писалось, исходящий трафик на серверы Prisma
(откуда CLI качает движок) заблокирован политикой окружения — поэтому
`npx prisma generate`/`migrate` там до конца не проходят (падают именно
на скачивании движка, `403 Forbidden` — см. ниже, это чужое ограничение
среды, не баг проекта). Что реально удалось проверить, а не просто
написать на глаз:

- **Реальное подключение к живому Postgres через тот же
  `@prisma/adapter-pg`**, который использует `PrismaService` — отдельным
  скриптом, `new PrismaPg(connectionString)` → `.connect()` →
  `queryRaw("SELECT 1 + 1")` против настоящего локального Postgres 16 —
  сработало и вернуло правильный результат.
- **`prisma.config.ts` реально подхватывается Prisma CLI** — `npx prisma
  generate` печатает `Loaded Prisma config from prisma.config.ts.` и
  падает только ПОСЛЕ этого, на скачивании движка (`Failed to fetch
  sha256 checksum ... 403 Forbidden`) — то есть конфиг и схема
  вычитываются корректно, дальше упирается исключительно в сеть
  песочницы.
- `npx tsc --noEmit` — по-прежнему не проходит по файлам, которые трогают
  Prisma (`PrismaService`, `SessionService`, `admin-panel`, `admin-auth`,
  `telegram-auth`/`telegram-login`, `cron`) с одной и той же причиной:
  сгенерированного клиента с типами под схему нет, пока `npx prisma
  generate` не выполнится там, где сеть открыта. Сама логика (API
  `.create/.findUnique/.update/.delete/.findMany/.deleteMany/.count`,
  стабильный уже много лет) написана и вычитана вручную.
- SQL-миграцию (`backend/prisma/migrations/20260904000000_init/migration.sql`)
  я написал руками (обычно её генерирует `prisma migrate diff`, но и это
  требует движка) — для такой простой одной таблицы SQL совсем короткий,
  проверил его глазами дважды, но реальный прогон против живой Postgres —
  за вами.

**Первое, что нужно сделать у себя** (сеть у вас открыта, ограничение
чисто из-за политики моей песочницы):

```bash
cd backend
npm install
npx prisma generate
npx tsc --noEmit   # убедиться, что всё компилируется
```

Если что-то не сойдётся — скорее всего, из явно объявленных типов
`Session`/`SessionStatus` (`common/types/session.types.ts`) разойдётся с
тем, что сгенерирует Prisma для JSON-колонки `data` — я типизирую её
через `as Session['originalVideo']` и т.п. в `toSession()`, это должно
быть безопасно, но именно это место стоит проверить первым, если tsc
что-то покажет.

## Prisma 7: конфигурация через `prisma.config.ts`, не `schema.prisma`

Проект на Prisma 7 (`@prisma/client`/`prisma` `^7.10.0`), где
`url`/`directUrl`/`shadowDatabaseUrl` в блоке `datasource` схемы —
**упразднены**. `backend/prisma/schema.prisma` теперь содержит только
`datasource db { provider = "postgresql" }`, без единой строки
подключения. Вместо этого:

- **`backend/prisma.config.ts`** — читается только Prisma CLI
  (`prisma migrate`, `prisma db pull`, `prisma studio`), никогда самим
  приложением. Его `datasource.url` — это `DIRECT_URL` (не
  `DATABASE_URL`): именно прямое, не-пуленное подключение нужно командам
  миграции — та же роль, что раньше играло поле `directUrl` в схеме.
- **`backend/src/prisma/prisma.service.ts`** — сам `PrismaClient` теперь
  требует явный driver adapter (`@prisma/adapter-pg`, пакет `pg`) —
  подключается напрямую к `DATABASE_URL` (пуленному) в конструкторе
  `PrismaService`, минуя и схему, и `prisma.config.ts` целиком:
  ```ts
  super({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  ```

Разделение `DATABASE_URL` (пуленный, для рантайма) / `DIRECT_URL`
(прямой, для миграций) осталось ровно тем же, что описано ниже —
поменялось только ГДЕ каждая строка прописана в коде, не её смысл.

`Dockerfile.dev` копирует `prisma.config.ts` в образ до `RUN npx prisma
generate` (сама генерация клиента переменных окружения больше не
требует — схема их не читает, только структуру), а
`docker-compose.yml`/`docker-compose.dev.yml` бинд-маунтят файл отдельным
томом, как `tsconfig.json`/`nest-cli.json`, — править его можно без
пересборки образа.

## Как это устроено

Документ описывает **таблицу сессий**, с которой всё начиналось; тогда
она в схеме была одна. Сейчас таблиц заметно больше — пользователи,
проекты и товары, манифесты бренда, библиотека разборов, заявки на
публикацию, журнал расходов. Разбор каждой таблицы и каждой написанной
руками миграции — в `doc/DATABASE-AUDIT.md`; здесь только сессия и
устройство подключения, общее для всех.

Таблица `sessions`:
- `id`, `status`, `createdAt`, `lastActivityAt` — обычные колонки (по ним
  можно фильтровать/сортировать, `lastActivityAt` используется для TTL-
  очистки).
- `data` (JSONB) — всё остальное, что накапливает воркфлоу
  (`originalVideo`, `videoAnalysis`, `productInformation`,
  `generationPrompt`, `generatedVideo`), одним блобом. Это специально —
  форма этих вложенных объектов совпадает один в один с `Session` из
  `session.types.ts` и меняется вместе с фичами; растить под неё отдельную
  SQL-схему/миграцию на каждое изменение было бы лишней работой, а искать
  сессию всё равно всегда по `id`, так что искать что-то внутри JSON
  прямо в SQL не требуется.

`SessionService` снаружи не изменился (`createSession`/`getSession`/
`updateSession`/... — те же сигнатуры, теперь возвращают `Promise`), так
что бизнес-логика в `analysis`/`video`/`prompt`/`product`/`generation`
модулях не переписывалась — только добавлен `await` в местах вызова.

## Настройка реального Supabase-проекta

1. В Supabase Dashboard → ваш проект → **Project Settings → Database →
   Connection string**.
2. Скопируйте **Transaction pooler** (порт `6543`, режим `transaction`) —
   это `DATABASE_URL`. Обязательно с `?pgbouncer=true&connection_limit=1`
   в конце (Prisma сам подставляет этот флаг, если формируете строку по
   образцу из `.env.example`).
3. Скопируйте **Direct connection** (порт `5432`) — это `DIRECT_URL`.
   Используется только `prisma migrate` — миграции ненадёжно работают
   через транзакционный pooler.
4. Впишите оба в `backend/.env` (или в Environment Variables на Vercel —
   для Preview и Production можно указать один и тот же проект Supabase
   или завести отдельный под Preview, как удобнее).
5. Примените миграцию на реальную базу:
   ```bash
   cd backend
   npx prisma migrate deploy
   ```
   (использует `DIRECT_URL` через `backend/prisma.config.ts`, см. выше;
   `DATABASE_URL` дальше в рантайме использует пуленный коннект через
   `PrismaService`'s driver adapter).

## Локальная разработка (docker-compose)

Ничего руками делать не нужно — `docker-compose.yml` поднимает локальный
`postgres:16-alpine` (сервис `db`) и перед стартом бэкенда сам гоняет
`npx prisma migrate deploy` против него. Подробности — `DOCKER.md`.

## TTL-очистка (`cleanupExpiredSessions`)

Метод остался, теперь просто `DELETE FROM sessions WHERE "lastActivityAt" <
cutoff`.

**Расписание с тех пор появилось** (этапы 26–29, `doc/STORAGE-AUDIT.md`):
`GET /api/cron/cleanup-sessions` в 03:00 UTC и `GET /api/cron/sweep-orphans`
в 03:30 — оба объявлены в `backend/vercel.json` и защищены `CRON_SECRET`.
Утверждение «нигде не вызывается по расписанию», стоявшее здесь раньше,
устарело и вводило в заблуждение ровно в том месте, где решают, нужно ли
заводить уборку самому.

Изменилось и главное: удаление строки теперь обязано удалять и файлы
сессии в Blob. Раньше уходила только строка, а файлы оставались в
хранилище навсегда — это чинилось как дефект, а не как оптимизация
(`doc/STORAGE-AUDIT.md`).
