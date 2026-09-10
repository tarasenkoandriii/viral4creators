# Локальная разработка и дебаг через Docker Compose

Это чисто локальная история — на Vercel бэкенд и фронтенд деплоятся не так
(см. `VERCEL-READINESS-AUDIT.md`). Тут просто нужно было поднять оба сервиса
одной командой и иметь возможность вешать дебаггер на бэкенд без танцев с
локальным Node/npm.

## Быстрый старт

1. Заполните реальными ключами `backend/.env` и `frontend/.env` (созданы из
   `.env.example`, значения пока плейсхолдеры — сервисы стартуют, но упадут
   на первом реальном вызове Gemini/Blob, пока не впишете настоящие
   ключи; AWS в проекте нет — всё файловое хранилище это Vercel Blob).
   `DATABASE_URL`/`DIRECT_URL` трогать не нужно — для docker-compose
   они переопределены на локальный Postgres (см. ниже).
2. `docker compose up --build`
3. Бэкенд: http://localhost:3000/api (health: `/api/health`)
   Фронтенд: http://localhost:5173

`Ctrl+C`, затем `docker compose down` — остановить и убрать контейнеры.
`docker compose down -v` — то же самое плюс удалить именованные/анонимные
тома (тогда `node_modules` внутри контейнеров пересоберутся с нуля при
следующем `up --build`, а локальная Postgres-база очистится и мигрирует
заново с нуля).

## Локальный Postgres (сессии)

Сервис `db` (`postgres:16-alpine`) — локальная замена Supabase на время
разработки (см. `PRISMA-SUPABASE.md` — как `SessionService` теперь хранит
сессии). Бэкенд ждёт, пока `db` пройдёт healthcheck, затем перед стартом
сам выполняет `npx prisma migrate deploy` — таблица `sessions` создастся
автоматически при первом `up`, руками ничего накатывать не нужно.

Данные живут в именованном volume `viral4creators-db-data` — переживают
`docker compose down`, но не `down -v`.

Позалезть внутрь базы:
```
docker compose exec db psql -U postgres -d viral4creators
```

Примечание: сборка образов тянет `node:24-alpine` с Docker Hub — в моей
песочнице исходящий трафик на registry-1.docker.io был запрещён (в вашем
окружении такого ограничения скорее всего нет). `docker compose config`
я прогнал и синтаксис/связи сервисов подтверждены валидными, но сам
`docker compose build` — проверьте у себя первым запуском.

## Редизайн UI

Делался сначала в отдельной копии `frontend-v2/` (порт 5174), но в
итоге выполнен прямо в `frontend/`: дизайн-система перенесена из
SilverFinance (палитра `silver`/`accent`, Sora + JetBrains Mono,
`src/components/ui/`), все экраны перестилизованы, там же — новые экраны
проектов (`doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md`, этап 8). Папка
`frontend-v2/` и сервис `frontend-v2` из `docker-compose.dev.yml` удалены
по решению владельца — актуальный UI один, на `http://localhost:5173`.

## Что тут устроено

- **Hot-reload**: `backend/src` и `frontend/src` (плюс конфиги) смонтированы
  с хоста внутрь контейнеров как bind mount — правите файлы локально в своей
  IDE, `nest start --watch` / Vite подхватывают изменения внутри контейнера.
- **node_modules не расшариваются с хостом** — специально: в
  `docker-compose.yml` для `node_modules` (и `dist` у бэкенда) используются
  анонимные volume поверх bind-mount всей директории. Если бы не это, ваш
  локальный `node_modules` (собранный под вашу ОС — macOS/Windows) затёр бы
  тот, что собрался внутри Linux-контейнера при билде образа, и нативные
  зависимости (если появятся) сломались бы. Значит после правки
  `package.json` нужно `docker compose up --build`, а не просто `up`.
- **VITE_USE_POLLING=true** для фронтенда — на некоторых связках Docker
  Desktop (особенно macOS) события изменения файлов из bind-mount не
  долетают до чисто событийного watcher'а, и HMR молча перестаёт работать.
  Polling это чинит ценой небольшого лишнего CPU. Если у вас Linux-хост и
  HMR и так работает — можно убрать эту переменную из compose-файла.
- **Vite слушает `0.0.0.0`** (добавлено в `vite.config.ts`) — иначе dev-сервер
  внутри контейнера биндится на `127.0.0.1` и порт `5173:5173` наружу ничего
  не даст, несмотря на проброс порта.
- Фронтенд ходит к бэкенду напрямую по `VITE_API_BASE_URL`
  (`http://localhost:3000/api` по умолчанию в `.env`), а не через прокси Vite
  — это уже так было в коде (`services/api.ts`), просто фиксирую, почему
  никакого docker-network адреса (`http://backend:3000`) нигде указывать не
  пришлось: браузер обращается к порту на хосте, а не изнутри
  контейнерной сети.

## Дебаг бэкенда (NestJS)

Контейнер бэкенда стартует не через обычный `start:dev`, а через новый
скрипт `start:docker:debug` (`backend/package.json`):

```
"start:docker:debug": "nest start --watch --debug=0.0.0.0:9229"
```

Обычный `nest start --debug` вешает инспектор на `127.0.0.1:9229` —
недоступно снаружи контейнера. Явный `--debug=0.0.0.0:9229` плюс проброс
порта `9229:9229` в `docker-compose.yml` — и инспектор торчит наружу.

### VS Code

`.vscode/launch.json` (создайте, если ещё нет):

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to backend (docker)",
      "port": 9229,
      "address": "localhost",
      "localRoot": "${workspaceFolder}/backend",
      "remoteRoot": "/app",
      "restart": true,
      "skipFiles": ["<node_internals>/**"]
    }
  ]
}
```

Поставьте точку останова в `backend/src/...`, `Run and Debug` →
`Attach to backend (docker)`. `restart: true` — VS Code переподключится
сам после того, как `--watch` перезапустит процесс из-за правки файла.

### Chrome DevTools

`chrome://inspect` → `Configure...` → добавить `localhost:9229` → `inspect`
под нужным таргетом.

## Дебаг фронтенда

Отдельного контейнерного шага не нужно — это обычный Vite dev-сервер,
достаточно DevTools браузера на `http://localhost:5173` (source maps уже
включены Vite по умолчанию).

## Логи

```
docker compose logs -f backend
docker compose logs -f frontend
```

## Если что-то не собирается/не стартует

- **`node:24-alpine: ... Forbidden` при `docker compose build`** — сеть или
  Docker Hub недоступны оттуда, откуда собираете; проверьте доступ к
  `registry-1.docker.io` или используйте зеркало реестра.
- **Бэкенд падает сразу на старте с `Missing required environment
  variables`** — `backend/.env` ещё не заполнен реальным `GEMINI_API_KEY`
  (единственная по-настоящему обязательная переменная, см.
  `configuration.ts`; ожидаемо сразу после клонирования, см. Быстрый старт
  выше).
- **`docker compose build backend` падает на `RUN npx prisma generate`
  с `Environment variable not found: DATABASE_URL`, ИЛИ бэкенд в цикле
  перезапускается с `Error: The datasource.url property is required in
  your Prisma config file when using prisma migrate deploy`** — это НЕ
  про сеть и НЕ про недостающий OpenSSL (хотя на `node:*-alpine` он тоже
  нужен — `Dockerfile.dev` ставит его через `apk add --no-cache
  openssl`). Причина — Prisma 7 упразднил `url`/`directUrl` в
  `schema.prisma`'s `datasource` целиком; проект уже перешёл на новую
  схему (`backend/prisma.config.ts` + driver adapter в
  `PrismaService`) — если видите эту ошибку на актуальной версии
  проекта, скорее всего `prisma.config.ts` не попал в образ (проверьте,
  что `Dockerfile.dev` его копирует и что он не исключён в
  `.dockerignore`) либо не замаунтен в `docker-compose*.yml` рядом с
  `./backend/prisma:/app/prisma`. Подробно, что и почему поменялось —
  `doc/PRISMA-SUPABASE.md`, раздел "Prisma 7: конфигурация через
  `prisma.config.ts`". **Не пытайтесь чинить это удалением
  `url`/`directUrl` из схемы без добавления `prisma.config.ts` и
  driver adapter одновременно** — по отдельности это ломает либо CLI
  (`migrate`), либо рантайм-подключение `PrismaClient`.
- **Бэкенд стартует, миграции применяются, но затем зацикливается на
  `Error  EBUSY: resource busy or locked, rmdir '/app/dist'`** — не про
  Prisma вообще. `/app/dist` в `docker-compose*.yml` — anonymous volume
  (защищает скомпилированный вывод контейнера), а `nest start --watch`
  по умолчанию (`nest-cli.json`'s `deleteOutDir: true`) перед каждой
  пересборкой удаляет и заново создаёт весь `outDir` — саму ТОЧКУ
  МОНТИРОВАНИЯ тома удалить изнутри контейнера нельзя (можно только её
  содержимое), отсюда `EBUSY`. Чинится один раз — `deleteOutDir: false`
  в `backend/nest-cli.json` — Nest CLI продолжает перезаписывать файлы
  внутри `dist/` инкрементально, просто не трогает саму директорию.
- **HMR не подхватывает правки** — на Linux-хосте попробуйте убрать
  `VITE_USE_POLLING=true`; на macOS/Windows, наоборот, если что-то не
  триггерится — она уже включена.
- **Бэкенд падает на `npx prisma migrate deploy` / не может подключиться к
  базе** — обычно значит, что `db` ещё не прошёл healthcheck (`depends_on:
  condition: service_healthy` должен был это предотвратить, но если
  Postgres поднимается необычно медленно на вашей машине — увеличьте
  `retries`/`interval` в healthcheck сервиса `db`), либо вы вручную
  поменяли `DATABASE_URL`/`DIRECT_URL` в `backend/.env` — для
  docker-compose их трогать не нужно (см. Быстрый старт).
