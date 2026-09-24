/**
 * Код приглашения на клиенте — «Условно бесплатный Lite» §5.1, этап 134.
 *
 * Проверяем ровно то, что нельзя проверить на сервере: как код
 * достаётся из адреса. Ошибка здесь не ломает ничего видимого —
 * приглашения просто перестают доходить, молча.
 */

import assert from 'node:assert/strict';
import {
  captureReferralCode,
  clearReferralCode,
  referralLink,
  telegramReferralLink,
  storedReferralCode,
} from '../src/lib/referral';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  console.log(`  ✓ ${name}`);
  passed++;
}

const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  location: { search: '', hash: '' },
};

function visit(search: string, hash = '') {
  const w = (globalThis as unknown as { window: { location: unknown } }).window;
  w.location = { search, hash };
}

console.log('код приглашения из адреса');

test('обычный фронтенд: ?ref=', () => {
  store.clear();
  visit('?ref=ABCD2345');
  captureReferralCode();
  assert.equal(storedReferralCode(), 'ABCD2345');
});

test('мини-апп: tgWebAppStartParam=r_КОД', () => {
  store.clear();
  visit('', '#tgWebAppData=x&tgWebAppStartParam=r_ABCD2345');
  captureReferralCode();
  assert.equal(storedReferralCode(), 'ABCD2345');
});

test('регистр прощаем — ссылку переписывают руками', () => {
  store.clear();
  visit('?ref=abcd2345');
  captureReferralCode();
  assert.equal(storedReferralCode(), 'ABCD2345');
});

test('мусор не запоминается', () => {
  store.clear();
  visit('?ref=НЕ-КОД');
  captureReferralCode();
  assert.equal(storedReferralCode(), null);
});

test('первое касание выигрывает: вторая ссылка не перетирает первую', () => {
  store.clear();
  visit('?ref=ABCD2345');
  captureReferralCode();
  visit('?ref=WXYZ6789');
  captureReferralCode();
  assert.equal(storedReferralCode(), 'ABCD2345');
});

test('чужой startapp без префикса r_ игнорируется', () => {
  // Telegram отдаёт один параметр на все нужды; чужое значение не
  // должно притворяться кодом приглашения.
  store.clear();
  visit('', '#tgWebAppStartParam=ABCD2345');
  captureReferralCode();
  assert.equal(storedReferralCode(), null);
});

test('очистка убирает код', () => {
  store.clear();
  visit('?ref=ABCD2345');
  captureReferralCode();
  clearReferralCode();
  assert.equal(storedReferralCode(), null);
});

test('ссылка собирается без двойного слэша', () => {
  assert.equal(
    referralLink('ABCD2345', 'https://site.example/'),
    'https://site.example/r/ABCD2345'
  );
});

test('t.me-вариант ссылки — тот же префикс startapp, что и разбор', () => {
  // Если эти два места разъедутся, приглашение из Telegram перестанет
  // засчитываться молча: код приедет, но `captureReferralCode` его не
  // узнает. Поэтому проверяем не строку руками, а круг: собрали ссылку
  // — разобрали её же.
  const url = telegramReferralLink('ABCD2345', 'v4c_bot');
  assert.equal(url, 'https://t.me/v4c_bot/app?startapp=r_ABCD2345');
  const startParam = new URL(url!).searchParams.get('startapp')!;
  store.clear();
  visit('', `#tgWebAppStartParam=${startParam}`);
  captureReferralCode();
  assert.equal(storedReferralCode(), 'ABCD2345');
});

test('собачка в имени бота срезается', () => {
  // `t.me/@бот` ведёт в никуда, а в переменную окружения имя чаще всего
  // копируют прямо из Telegram — вместе с собачкой.
  assert.equal(
    telegramReferralLink('ABCD2345', ' @v4c_bot '),
    'https://t.me/v4c_bot/app?startapp=r_ABCD2345'
  );
});

test('имени бота нет — t.me-варианта нет', () => {
  // Выдуманное имя увело бы приглашённых к ЧУЖОМУ боту; кабинет в этом
  // случае делится лендинговой ссылкой, она работает везде.
  assert.equal(telegramReferralLink('ABCD2345', undefined), null);
  assert.equal(telegramReferralLink('ABCD2345', '   '), null);
  assert.equal(telegramReferralLink('ABCD2345', '@'), null);
});

console.log(`\n${passed} проверок пройдено`);
