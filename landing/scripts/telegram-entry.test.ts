/**
 * Вход из лендинга в сценарий мини-аппа: браузерная ссылка и
 * «Открыть в Telegram» (`src/lib/telegram-entry.ts`).
 *
 * Проверяется то, что ломается молча: формат `startapp` (лимит Telegram
 * 64 знака, алфавит `[A-Za-z0-9_-]`), перенос кода приглашения, отказ от
 * негодного имени бота — и главное, что строку, собранную здесь, тем же
 * сценарием разбирает frontend (`frontend/src/lib/start-param.ts`).
 * Схема та же, что у остальных тестов лендинга: `node:assert` + `tsx`.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  LANDING_ENTRIES,
  START_PARAM_ALPHABET,
  START_PARAM_MAX_LENGTH,
  browserEntryLink,
  entryReferralCode,
  entryStartParam,
  isLandingEntry,
  normalizeBotUsername,
  telegramEntryLink,
} from '../src/lib/telegram-entry';
import { START_PARAM_PREFIX } from '../src/lib/referral';
import { getDictionary } from '../src/lib/get-dictionary';
import { locales } from '../src/lib/i18n';

const CODE = 'ABCD2345';
const BOT = 'v4c_bot';

async function main() {
  // ── startapp ──────────────────────────────────────────────────────────
  assert.equal(entryStartParam('ads'), 'e_ads');
  assert.equal(entryStartParam('greetings'), 'e_greetings');
  assert.equal(entryStartParam('site-tutorial'), 'e_site-tutorial');
  assert.equal(entryStartParam('greetings', CODE), `e_greetings__r_${CODE}`);
  // Код из адреса — регистр и пробелы прощаем, как `/r/<код>`.
  assert.equal(entryStartParam('greetings', ' abcd2345 '), `e_greetings__r_${CODE}`);
  // Негодный код отбрасывается, сценарий остаётся: человек всё равно
  // должен попасть в нужный мастер.
  for (const bad of ['', 'ABCD234', 'ABCD23456', 'ABCD2341', 'ABCD-345', 'НЕ-КОД', null, undefined]) {
    assert.equal(entryStartParam('greetings', bad), 'e_greetings', String(bad));
  }
  // Приглашение — тем же префиксом, что у страницы `/r/<код>`.
  assert.ok(entryStartParam('ads', CODE).endsWith(`__${START_PARAM_PREFIX}${CODE}`));

  // Все комбинации влезают в лимит Telegram и в его алфавит.
  for (const entry of LANDING_ENTRIES) {
    for (const code of [null, CODE, 'ZZZZ9999']) {
      const raw = entryStartParam(entry, code);
      assert.ok(raw.length <= START_PARAM_MAX_LENGTH, raw);
      assert.ok(START_PARAM_ALPHABET.test(raw), raw);
    }
  }
  assert.equal(entryStartParam('site-tutorial', CODE).length, 27);

  // Закрытый список.
  assert.ok(isLandingEntry('greetings'));
  assert.equal(isLandingEntry('shop'), false);
  assert.equal(isLandingEntry('toString'), false);
  assert.equal(entryReferralCode('%41BCD2345'), null, 'URLSearchParams уже раскодировал');

  // ── Имя бота ──────────────────────────────────────────────────────────
  assert.equal(normalizeBotUsername(' @v4c_bot '), BOT);
  for (const bad of [null, undefined, '', '   ', '@', 'abc', 'v4c bot', 'v4c-bot', '1v4cbot', 'a'.repeat(33), 'evil.com/x']) {
    assert.equal(normalizeBotUsername(bad), null, String(bad));
    assert.equal(telegramEntryLink('greetings', bad), null, `нет кнопки для ${String(bad)}`);
  }

  // ── Ссылки ────────────────────────────────────────────────────────────
  assert.equal(telegramEntryLink('greetings', BOT), 'https://t.me/v4c_bot/app?startapp=e_greetings');
  assert.equal(
    telegramEntryLink('site-tutorial', '@v4c_bot', CODE),
    `https://t.me/v4c_bot/app?startapp=e_site-tutorial__r_${CODE}`,
  );
  assert.equal(telegramEntryLink('ads', BOT, 'мусор'), 'https://t.me/v4c_bot/app?startapp=e_ads');

  // Браузер: ровно та строка, что была на страницах до этой правки.
  const TMA = 'https://app.example.com';
  assert.equal(browserEntryLink('greetings', TMA), `${TMA}?entry=greetings#/projects/new`);
  assert.equal(browserEntryLink('site-tutorial', TMA), `${TMA}?entry=site-tutorial#/projects/new`);
  assert.equal(browserEntryLink('ads', TMA), `${TMA}?entry=ads#/projects/new`);
  assert.equal(browserEntryLink('greetings', TMA, 'abcd2345'), `${TMA}?entry=greetings&ref=${CODE}#/projects/new`);
  assert.equal(browserEntryLink('greetings', TMA, '<x>'), `${TMA}?entry=greetings#/projects/new`);

  // ── Словари ──────────────────────────────────────────────────────────
  for (const locale of locales) {
    const label = getDictionary(locale).entryActions.telegramCta;
    assert.ok(typeof label === 'string' && label.includes('Telegram'), locale);
  }

  // ── Сквозная проверка с разбором во frontend ─────────────────────────
  // Динамический импорт по вычисленному пути: `tsc` лендинга не тянет
  // исходники frontend в свою проверку, а `tsx` их исполняет. Лендинг
  // без соседнего frontend (отдельный чекаут) — проверка пропускается.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const frontendParser = path.resolve(here, '../../frontend/src/lib/start-param.ts');
  if (existsSync(frontendParser)) {
    const fe = (await import(pathToFileURL(frontendParser).href)) as {
      parseStartParam: (raw: string) => { entry: string | null; referralCode: string | null };
    };
    for (const entry of LANDING_ENTRIES) {
      for (const code of [null, CODE]) {
        const url = new URL(telegramEntryLink(entry, BOT, code)!);
        assert.deepEqual(fe.parseStartParam(url.searchParams.get('startapp')!), { entry, referralCode: code }, url.href);
      }
    }
    console.log('telegram-entry: строки лендинга разобраны парсером frontend');
  } else {
    console.log('telegram-entry: frontend рядом нет — сквозная проверка пропущена');
  }

  console.log('telegram-entry: startapp format, 64-char limit, alphabet, referral carry-over, bot name and dictionaries checked');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
