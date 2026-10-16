# Telegram: основной домен и Mini App — 16.10.2026

## Выполнено

Настройка выполнена владельческим вторым аккаунтом Telegram через официальный BotFather. Токены не запрашивались и не менялись.

- `/setdomain` для `@Viral4creatorsBot`: `viral4creators.app`; ответ «Success! Domain updated.».
- Создан Mini App с коротким именем `app`, названием Viral4creators, описанием «UGC-видео, обучающие ролики и сказки с голосом близкого.», фотографией 640×360 из OG лендинга; без GIF.
- URL Mini App: `https://viral4creators.app`; BotFather подтвердил `https://t.me/Viral4creatorsBot/app`.
- Кнопка меню: «Открыть приложение», URL `https://viral4creators.app`; ответ «Success! Menu settings updated.».
- Настройка Login Widget относится к основному боту; домены AdminBot и бота помощника не изменялись.

## Доставка лендингов

В `viral-landing` Production установлен `NEXT_PUBLIC_TMA_URL=https://viral4creators.app`. Переменная `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME=Viral4creatorsBot` уже присутствовала в Production+Preview.

Выпуск `dpl_6y2pj5U9WK4EPBLwDJeHzMA8HuLu`, `viral-landing-qz4v2wqnk-sibionics-ai.vercel.app`: Ready. Источник — ранее успешный выпуск на коммите `3bd2b8b`. Обычный env-only redeploy был отменён штатным ignored-build hook из-за отсутствия Git diff; повтор выполнен с предусмотренным `VERCEL_FORCE_BUILD=1`. Временная переменная удалена после успеха.

Все домены `welcome`, `greeting`, `tutorial`, `story-tales.viral4creators.app` указывают на новый выпуск. По живому HTML проверены CTA:

- welcome: `app?startapp=e_ads`, браузер `https://viral4creators.app?entry=ads#/projects/new`;
- greeting: `app?startapp=e_greetings`, браузер с `entry=greetings` и выбранным поводом на основном домене;
- tutorial: `app?startapp=e_site-tutorial`, браузер `entry=site-tutorial` на основном домене;
- Story‑Tales: `app?startapp=e_stories`.

## Подтверждённое исполнение и границы

После нажатия ссылки нового Mini App и подтверждения LAUNCH в Telegram Web загрузилось приложение с origin `viral4creators.app`, меню продуктов и сохранённой авторизованной сессией Premium. Браузерный переход `https://viral4creators.app?entry=stories#/stories` показал раздел Story‑Tales.

Дополнительно выполнен настоящий запуск `https://t.me/Viral4creatorsBot/app?startapp=e_stories` из Избранного второго аккаунта Telegram. Встроенное приложение открылось на `viral4creators.app/?tgWebAppStartParam=e_stories&entry=stories#/stories`, показало заголовок Story‑Tales и кнопку настройки рассказчика. Передача параметра и маршрутизация подтверждены.

Новый вход Login Widget без сохранённой сессии пока отдельно не подтверждён; успех настройки домена не подменяет эту проверку. Старое именованное приложение `viral4creators` не удалено и сохраняет прежний URL `https://viral-frontend.vercel.app/`; новый путь `app` настроен на основной домен. Main Mini App в профиле бота отдельно не переключался.

Подтверждение BotFather сохранено локально: `outputs/telegram-setup/botfather-mini-app-menu.jpg` (вне репозитория, без токенов).

Скриншот сквозного запуска: `outputs/telegram-setup/story-tales-telegram-launch.jpg` (вне репозитория).
