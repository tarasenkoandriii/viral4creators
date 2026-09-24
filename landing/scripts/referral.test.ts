/**
 * Страница приглашения — `/r/<код>`, ТЗ «Условно бесплатный Lite» §5.1,
 * этап 134. Схема та же, что у остальных тестов лендинга: `node:assert`
 * + `tsx`, чистые функции.
 *
 * Проверяется не вёрстка, а те три места, где ошибка стоит дорого и
 * незаметна: что за код мы принимаем, куда ведут обе дороги и что
 * словари не разъехались.
 */
import assert from 'node:assert/strict';
import {
  appInviteLink,
  isLinkPreviewAgent,
  normalizeCode,
  START_PARAM_PREFIX,
  telegramInviteLink,
} from '../src/lib/referral';
import { getDictionary } from '../src/lib/get-dictionary';
import { locales } from '../src/lib/i18n';

// ── Код ───────────────────────────────────────────────────────────────

assert.equal(normalizeCode('ABCD2345'), 'ABCD2345');
// Регистр и пробелы человек приносит из мессенджера — это тот же код.
assert.equal(normalizeCode('  abcd2345 '), 'ABCD2345');
// Процентная кодировка: адрес мог приехать через чужой редирект.
assert.equal(normalizeCode('%41BCD2345'), 'ABCD2345');
// Похожие друг на друга знаки выброшены из алфавита на сервере
// (`backend/src/common/referral.ts`) — значит, и здесь их быть не может,
// иначе лендинг ходил бы в API с кодом, которого не бывает.
for (const bad of ['ABCD234I', 'ABCD234O', 'ABCD2340', 'ABCD2341']) {
  assert.equal(normalizeCode(bad), null, bad);
}
// Длина ровно восемь.
assert.equal(normalizeCode('ABCD234'), null);
assert.equal(normalizeCode('ABCD23456'), null);
// Мусор и пустота — 404, а не поход в API: маршрут анонимный, и
// перебирать им коды не должно быть дёшево.
assert.equal(normalizeCode(''), null);
assert.equal(normalizeCode(null), null);
assert.equal(normalizeCode(undefined), null);
assert.equal(normalizeCode('../../etc'), null);

// ── Две дороги ────────────────────────────────────────────────────────

// `startapp` с префиксом — ровно тот, который разбирает мини-апп
// (`frontend/src/lib/referral.ts`, START_PARAM_PREFIX там же).
assert.equal(START_PARAM_PREFIX, 'r_');
assert.equal(
  telegramInviteLink('ABCD2345', 'v4c_bot'),
  'https://t.me/v4c_bot/app?startapp=r_ABCD2345',
);
// Имя бота в переменной окружения человек задаст и с собачкой — в
// `t.me/@бот` она лишняя и ведёт в никуда.
assert.equal(
  telegramInviteLink('ABCD2345', '@v4c_bot'),
  'https://t.me/v4c_bot/app?startapp=r_ABCD2345',
);

// Браузерная дорога — тем же обычным query-параметром, каким уже
// приходит `?fromShared=`; лишний слэш из env не должен давать `//?ref=`.
assert.equal(
  appInviteLink('ABCD2345', 'https://app.example'),
  'https://app.example?ref=ABCD2345',
);
assert.equal(
  appInviteLink('ABCD2345', 'https://app.example/'),
  'https://app.example?ref=ABCD2345',
);

// ── Кто считается переходом ───────────────────────────────────────────

// Мессенджеры ходят за Open Graph-карточкой сами: без этой проверки
// отправленное в три чата приглашение показало бы три перехода раньше,
// чем его кто-нибудь открыл.
for (const ua of [
  'TelegramBot (like TwitterBot)',
  'WhatsApp/2.23.20.0 A',
  'facebookexternalhit/1.1',
  'Twitterbot/1.0',
  'Slackbot-LinkExpanding 1.0',
  'Mozilla/5.0 (compatible; Discordbot/2.0)',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; YandexBot/3.0)',
]) {
  assert.equal(isLinkPreviewAgent(ua), true, ua);
}

// А живые браузеры — считаются. Ошибка в эту сторону дороже: принять
// человека за робота значит потерять переход у того, кто действительно
// привёл друга.
for (const ua of [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
]) {
  assert.equal(isLinkPreviewAgent(ua), false, ua);
}

// Агента нет вовсе — считаем переходом: это скорее человек с урезанным
// заголовком, чем робот, который о себе молчит.
assert.equal(isLinkPreviewAgent(null), false);
assert.equal(isLinkPreviewAgent(undefined), false);
assert.equal(isLinkPreviewAgent(''), false);

// ── Словари ───────────────────────────────────────────────────────────

// Форму держит тип (`Dictionary = typeof ru`), но пустая строка типом не
// ловится, а на странице она выглядит как пропавшая кнопка.
for (const locale of locales) {
  const t = getDictionary(locale).referral;
  for (const [key, value] of Object.entries(t)) {
    assert.equal(typeof value, 'string', `${locale}.referral.${key}`);
    assert.ok((value as string).trim().length > 0, `${locale}.referral.${key}`);
  }
}

console.log('referral: ok');
