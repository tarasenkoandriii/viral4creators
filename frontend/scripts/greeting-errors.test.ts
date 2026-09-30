// Plain assertions runnable with `npx tsx scripts/greeting-errors.test.ts`.
//
// CONTRACT6 G-FE п. 8: отказы поздравления — переводом по коду сервера
// (`error.details.code`), неизвестный код — текстом сервера, пустой
// ответ — общим текстом, а не русской строкой «Пустой ответ».

import { readFileSync, existsSync } from 'node:fs';
import {
  EmptyResponseError,
  describeGreetingError,
  greetingErrorCodeOf,
  greetingErrorCodeOfError,
  GREETING_SCRIPT_STALE,
} from '../src/lib/greeting-errors';
import ru from '../src/dictionaries/ru.json';
import uk from '../src/dictionaries/uk.json';
import en from '../src/dictionaries/en.json';
import de from '../src/dictionaries/de.json';
import es from '../src/dictionaries/es.json';

let failed = 0;
let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(a: unknown, b: unknown) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}

const axiosLike = (data: unknown) => ({ response: { status: 409, data } });
const table = { GREETING_SCRIPT_STALE: 'Соберите заново' };
const fallback = (e: unknown) =>
  `fallback:${(e as { message?: string })?.message ?? 'x'}`;

check('код из error.details.code', () => {
  eq(
    greetingErrorCodeOf({ error: { details: { code: 'GREETING_X' } } }),
    'GREETING_X'
  );
  eq(greetingErrorCodeOf({ error: { message: 'x' } }), null);
  eq(greetingErrorCodeOf({ error: { details: { code: 5 } } }), null);
  eq(greetingErrorCodeOf(null), null);
  eq(greetingErrorCodeOf('строка'), null);
});

check('известный код — перевод словаря, а не текст сервера', () => {
  const err = axiosLike({
    error: {
      message: 'Сценарий собран для других фото',
      details: { code: 'GREETING_SCRIPT_STALE' },
    },
  });
  eq(describeGreetingError(err, table, 'generic', fallback), 'Соберите заново');
});

check('неизвестный код и нет кода — прежний разбор (текст сервера)', () => {
  const unknown = Object.assign(new Error('srv'), {
    response: { data: { error: { details: { code: 'GREETING_NEW' } } } },
  });
  eq(
    describeGreetingError(unknown, table, 'generic', fallback),
    'fallback:srv'
  );
  eq(
    describeGreetingError(new Error('plain'), table, 'generic', fallback),
    'fallback:plain'
  );
});

check('код-имя из прототипа (toString) не достаёт функцию', () => {
  const err = Object.assign(new Error('srv'), {
    response: { data: { error: { details: { code: 'toString' } } } },
  });
  eq(describeGreetingError(err, table, 'generic', fallback), 'fallback:srv');
});

check('пустой ответ — общий текст на языке интерфейса', () => {
  const e = new EmptyResponseError('greeting-video');
  eq(
    describeGreetingError(e, table, 'Что-то пошло не так', fallback),
    'Что-то пошло не так'
  );
  // Технический текст — для журнала и без русского.
  eq(/[А-Яа-яЁё]/.test(e.message), false);
});

check('«сценарий устарел» узнаётся по коду из ошибки запроса', () => {
  eq(
    greetingErrorCodeOfError(
      axiosLike({ error: { details: { code: GREETING_SCRIPT_STALE } } })
    ),
    'GREETING_SCRIPT_STALE'
  );
  eq(greetingErrorCodeOfError(new Error('x')), null);
  eq(greetingErrorCodeOfError(null), null);
});

check('greetingUi.scriptStaleHint: во всех локалях есть {button}', () => {
  for (const [loc, d] of Object.entries({ ru, uk, en, de, es })) {
    const t = (d as { greetingUi: { scriptStaleHint: string } }).greetingUi
      .scriptStaleHint;
    if (!t.includes('{button}')) throw new Error(`${loc}: нет {button}`);
  }
});

// ── Словари: каждый код сервера переведён во всех пяти локалях ─────────

const backendCodes = new URL(
  '../../backend/src/common/greeting-errors.ts',
  import.meta.url
);
const dicts = { ru, uk, en, de, es } as Record<
  string,
  { greetingErrors: Record<string, string> }
>;

check(
  'greetingErrors: все коды backend/common/greeting-errors.ts, пять локалей',
  () => {
    if (!existsSync(backendCodes)) {
      // Фронтенд собирают и отдельно от бэкенда — тогда сверять не с чем.
      console.log('    (backend не рядом — сверка кодов пропущена)');
      return;
    }
    const src = readFileSync(backendCodes, 'utf8');
    const codes = [...src.matchAll(/'(GREETING_[A-Z0-9_]+)'/g)].map(
      (m) => m[1]
    );
    if (codes.length < 10)
      throw new Error(`кодов найдено мало: ${codes.length}`);
    for (const [loc, d] of Object.entries(dicts)) {
      const missing = [...new Set(codes)].filter(
        (c) => !(typeof d.greetingErrors[c] === 'string' && d.greetingErrors[c])
      );
      if (missing.length)
        throw new Error(`${loc}: нет перевода ${missing.join(', ')}`);
    }
  }
);

check(
  'voiceConsent.costCredit: ru/uk — четыре формы, остальные — one/other',
  () => {
    const forms = (d: unknown) =>
      Object.keys(
        (d as { voiceConsent: { costCredit: Record<string, string> } })
          .voiceConsent.costCredit
      ).sort();
    eq(forms(ru), ['few', 'many', 'one', 'other']);
    eq(forms(uk), ['few', 'many', 'one', 'other']);
    for (const d of [en, de, es]) eq(forms(d), ['one', 'other']);
  }
);

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
