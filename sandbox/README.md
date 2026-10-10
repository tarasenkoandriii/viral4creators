# Sandbox Viral4Creators

Тестовая среда для QA и tutorial. Домен: sandbox.viral4creators.app.

## Сценарии

- Вход: demo@example.test / SandboxDemo123!; неверный пароль, успешный вход, обновление страницы, выход.
- Кабинет: выбрать периодичность уведомлений, сохранить, проверить после обновления.
- Заявка: обязательные поля, email, select, textarea, checkbox; сообщение об успешной отправке.
- Tutorial: три шага, завершение, сброс.
- Health реального assist-api: приложение работает и database=up.

Вход демонстрационный, состояние хранится в sessionStorage конкретного браузера. Это fixture для действий tutorial, а не настоящая серверная авторизация. Не вводить рабочие пароли или персональные данные. Отправка заявки никому ничего не отправляет. Каждый браузерный контекст изолирован; накопления записей в production нет.

## Размещение в монорепозитории

Папку sandbox разместить в корне viral4creators; workflow из sandbox/.github/workflows/sandbox-daily.yml перенести в корневую .github/workflows/sandbox-daily.yml.

Vercel: отдельный проект viral4creators-sandbox, Root Directory sandbox, Framework Other; конфигурация сборки находится в vercel.json. Добавить домен sandbox.viral4creators.app, внести DNS-запись, которую покажет Vercel. Для браузерного worker сайт должен быть доступен без Vercel Authentication; на странице нет закрытых данных.

GitHub Actions: установить repository variable SANDBOX_URL=https://sandbox.viral4creators.app. Ежедневный workflow в 06:17 UTC (09:17 Киев летом, 08:17 зимой) плюс ручной запуск. Для schedule workflow должен находиться в default branch. Отчёты HTML, trace и screenshots при ошибках хранятся 14 дней. Отдельные внешние уведомления не настроены; статус виден в GitHub Actions.

## Локальная проверка

Node 22 или 24:

```sh
npm ci
npx playwright install chromium
npm test
```

Без SANDBOX_URL тесты запускают локальный сайт; с переменной проверяют развёрнутый. Для дополнительной проверки базы: ASSIST_API_URL=https://assist-api.viral4creators.app.

## Подключение настоящего помощника и tutorial

Создать отдельный сайт sandbox.viral4creators.app в кабинете помощника, подтвердить владение и включить виджет. Не использовать ключ рабочего сайта. Код установки виджета взять из кабинета и добавить в public/index.html. Загрузчик и публичный ключ в этой версии не заданы: автоматический ответ LLM пока не тестируется.

Для tutorial браузерному worker передать этот домен как отдельную цель, а демонстрационную учётную запись — через штатный реестр credentials. Прогон API tutorial-explore требует авторизации, siteId и работающего browser-worker; текущий workflow проверяет страницы и health, но ещё не вызывает tutorial-explore/QA pipeline и не оценивает ответы LLM. Публичные демонстрационные данные не дают доступа к реальным аккаунтам.

Документация: https://playwright.dev/docs/ci и https://vercel.com/docs/project-configuration/vercel-json.
