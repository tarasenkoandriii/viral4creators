---
title: JS API віджета %%global%% — документація %%brand%%
heading: JS API віджета
description: Як керувати віджетом помічника з коду сторінки: відкрити чат, поставити питання, передати контекст і покупця, події, власна кнопка.
---
Сторінка керує віджетом через глобальну функцію `%%global%%(команда, …)`. Виклики до завантаження віджета не губляться: поставте заглушку черги до тегу — завантажувач виконає накопичене.

:::claim js-api
## Заглушка черги

```js
window.%%global%% = window.%%global%% || function () {
  (window.%%global%%.q = window.%%global%%.q || []).push(arguments);
};
```

## Команди

Table: Команди %%global%%
| Виклик | Що робить |
| `%%global%%('open')`, `('close')`, `('toggle')` | Відкрити, закрити, перемкнути чат |
| `%%global%%('ask', 'Скільки коштує доставка?')` | Відкрити чат і поставити питання (до 500 символів) |
| `%%global%%('context', { plan: 'pro', cartTotal: 1299 })` | Контекст сторінки для відповідей: до 20 ключів, рядки або числа |
| `%%global%%('identify', { name, email, externalId, userHash })` | Заповнити форму заявки; з `userHash` — підтверджений покупець |
| `%%global%%('position', 'bottom-left')` | Перенести кнопку в інший кут |
| `%%global%%('hide')`, `('show')` | Сховати й показати кнопку |
| `%%global%%('route')` | Повідомити про перехід SPA, якщо роутер не використовує History API |
| `%%global%%('goal', 'purchase', { value, currency, orderId })` | Досягнута ціль — див. [цілі](/%%loc%%/docs/assistant/goals) |
| `%%global%%('on', 'open', fn)` | Підписка на подію: `open`, `close`, `lead`, `handoff`, `goal` |
| `%%global%%('destroy')` | Прибрати віджет зі сторінки |

Невідома команда або неправильний аргумент ігноруються мовчки — віджет не ламає вашу сторінку.

## Власна кнопка

З атрибутом `data-launcher="none"` кнопки віджета немає, а чат відкриває будь-яке посилання на `%%anchor%%` або ваш виклик `%%global%%('open')`:

```html
<a href="%%anchor%%">Поставити питання</a>
```

## Підтверджений покупець

`userHash` — це HMAC-SHA256 від `externalId` секретом ідентичності сайту. Рахуйте його лише на своєму сервері: секрет не можна віддавати в браузер. Секрет видає власник сайту в кабінеті («Інтеграції»).

```js
import { createHmac } from 'node:crypto';
const userHash = createHmac('sha256', process.env.ASSIST_IDENTITY_SECRET).update(customer.id).digest('hex');
```
:::
