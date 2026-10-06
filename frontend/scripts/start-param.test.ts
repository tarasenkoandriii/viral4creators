/**
 * `startapp` из Telegram → сценарий лендинга и код приглашения.
 *
 * Лендинг даёт кнопку «Открыть в Telegram» со ссылкой
 * `t.me/<бот>/app?startapp=e_<сценарий>[__r_<код>]`
 * (`landing/src/lib/telegram-entry.ts`). Здесь проверяется вторая
 * половина: что мини-апп из этого параметра попадает ровно туда же, куда
 * браузерная кнопка того же лендинга (`?entry=<сценарий>`), что код
 * приглашения из составного параметра не теряется, и что всё, что не
 * соответствует формату, не значит ничего.
 *
 * Запуск: `npm test` во frontend.
 */
import assert from 'node:assert/strict';
import {
  START_PARAM_ALPHABET,
  START_PARAM_MAX_LENGTH,
  buildStartParam,
  parseStartParam,
  startParamFromLaunch,
} from '../src/lib/start-param';
import {
  LANDING_ENTRIES,
  entryLaunchUrl,
  projectTypeFromSearch,
} from '../src/features/projects/landing-entry';
import { captureReferralCode, storedReferralCode } from '../src/lib/referral';
import { initTelegramWebApp } from '../src/lib/telegram';

let passed = 0;
function it(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const NOTHING = { entry: null, referralCode: null };
const CODE = 'ABCD2345';

console.log('start-param');

it('сценарий без кода', () => {
  assert.deepEqual(parseStartParam('e_greetings'), {
    entry: 'greetings',
    referralCode: null,
  });
  assert.deepEqual(parseStartParam('e_site-tutorial'), {
    entry: 'site-tutorial',
    referralCode: null,
  });
  assert.deepEqual(parseStartParam('e_ads'), {
    entry: 'ads',
    referralCode: null,
  });
});

it('сценарий и код приглашения в одном параметре', () => {
  assert.deepEqual(parseStartParam(`e_greetings__r_${CODE}`), {
    entry: 'greetings',
    referralCode: CODE,
  });
  assert.deepEqual(parseStartParam(`e_site-tutorial__r_${CODE}`), {
    entry: 'site-tutorial',
    referralCode: CODE,
  });
});

it('старый формат приглашения r_<код> разбирается как раньше', () => {
  assert.deepEqual(parseStartParam(`r_${CODE}`), {
    entry: null,
    referralCode: CODE,
  });
  // Регистр прощался и до этой правки (ссылку переписывают руками).
  assert.deepEqual(parseStartParam('r_abcd2345'), {
    entry: null,
    referralCode: CODE,
  });
});

it('незнакомый сценарий — ничего, в том числе код рядом с ним', () => {
  for (const raw of [
    'e_shop',
    'e_',
    'e_GREETINGS',
    'e_toString',
    'e___proto__',
    `e_shop__r_${CODE}`,
  ]) {
    assert.deepEqual(parseStartParam(raw), NOTHING, raw);
  }
});

it('негодный код — ничего, в том числе сценарий рядом с ним', () => {
  for (const raw of [
    'e_greetings__r_',
    'e_greetings__r_ABCD234',
    'e_greetings__r_ABCD23456',
    'e_greetings__r_ABCD2341', // «1» нет в алфавите кода
    'r_ABCD-345',
  ]) {
    assert.deepEqual(parseStartParam(raw), NOTHING, raw);
  }
});

it('порядок и количество частей строгие', () => {
  for (const raw of [
    `r_${CODE}__e_greetings`,
    'e_greetings__e_ads',
    `r_${CODE}__r_${CODE}`,
    `e_greetings__r_${CODE}__x`,
    'e_greetings__',
    '__e_greetings',
    'e_greetings___r_ABCD2345',
    `e_greetings_r_${CODE}`,
    'greetings',
  ]) {
    assert.deepEqual(parseStartParam(raw), NOTHING, raw);
  }
});

it('чужие префиксы и мусор — ничего', () => {
  for (const raw of [
    null,
    undefined,
    '',
    'cst_site123', // это `assist-site-link.ts`, не наш формат
    CODE,
    'e_greetings ',
    `r_${CODE} `, // пробелы прощает только ?ref=, не startapp
    ` r_${CODE}`,
    'e_greetings%20',
    'e_greetings&r=1',
    'e_грeetings',
  ]) {
    assert.deepEqual(parseStartParam(raw), NOTHING, String(raw));
  }
});

it('длиннее 64 знаков — ничего', () => {
  // Честная оговорка: по грамматике самая длинная годная строка — 27
  // знаков, так что предел здесь — страховка на будущее расширение
  // формата, а не то, что сегодня что-то отсекает в одиночку.
  const long = `e_greetings__r_${CODE}`.padEnd(START_PARAM_MAX_LENGTH + 1, 'A');
  assert.equal(long.length, 65);
  assert.deepEqual(parseStartParam(long), NOTHING);
});

it('каждая комбинация собирается в ≤ 64 знака алфавита Telegram и разбирается обратно', () => {
  for (const entry of [null, ...LANDING_ENTRIES]) {
    for (const referralCode of [null, CODE, 'ZZZZ9999']) {
      const raw = buildStartParam({ entry, referralCode });
      if (!entry && !referralCode) {
        assert.equal(raw, null);
        continue;
      }
      assert.ok(raw, `${entry}/${referralCode}`);
      assert.ok(raw!.length <= START_PARAM_MAX_LENGTH, raw!);
      assert.ok(START_PARAM_ALPHABET.test(raw!), raw!);
      assert.deepEqual(parseStartParam(raw), { entry, referralCode });
    }
  }
  // Самая длинная строка формата — с запасом.
  assert.equal(
    buildStartParam({ entry: 'site-tutorial', referralCode: CODE }),
    `e_site-tutorial__r_${CODE}`
  );
});

it('сборка отказывается от негодных частей, а не тихо их выбрасывает', () => {
  assert.equal(
    buildStartParam({ entry: 'greetings', referralCode: 'bad' }),
    null
  );
  assert.equal(
    buildStartParam({ entry: 'shop' as never, referralCode: CODE }),
    null
  );
});

it('источник: hash запуска первым, SDK — запасной', () => {
  assert.equal(
    startParamFromLaunch(
      '#tgWebAppData=x&tgWebAppStartParam=e_ads',
      'e_greetings'
    ),
    'e_ads'
  );
  assert.equal(
    startParamFromLaunch('#tgWebAppData=x', 'e_greetings'),
    'e_greetings'
  );
  assert.equal(startParamFromLaunch('', null), null);
});

it('сценарий из startapp ведёт туда же, куда ?entry= того же лендинга', () => {
  for (const entry of LANDING_ENTRIES) {
    const url = entryLaunchUrl('/', '', entry);
    assert.equal(url, `/?entry=${entry}#/projects/new`);
    const search = url.slice(url.indexOf('?'), url.indexOf('#'));
    assert.equal(
      projectTypeFromSearch(search),
      projectTypeFromSearch(`?entry=${entry}`)
    );
    assert.notEqual(projectTypeFromSearch(search), null, entry);
  }
  // Прочие параметры адреса запуска не теряются.
  assert.equal(
    entryLaunchUrl('/app/', '?utm_source=tg', 'greetings'),
    '/app/?utm_source=tg&entry=greetings#/projects/new'
  );
});

// ── Запуск мини-аппа целиком: порядок «разобрать → очистить hash» ──

const store = new Map<string, string>();
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
interface FakeWindow {
  location: { pathname: string; search: string; hash: string };
  history: { replaceState: (s: unknown, t: string, url: string) => void };
  localStorage: typeof storage;
  sessionStorage: typeof storage;
  Telegram?: unknown;
}
const g = globalThis as unknown as {
  window: FakeWindow;
  document: unknown;
  localStorage: typeof storage;
};
g.localStorage = storage;
g.document = {
  documentElement: { classList: { toggle() {}, contains: () => true } },
};

/** Открыть мини-апп «как Telegram» и вернуть адрес после старта. */
function launch(hash: string, sdkStartParam?: string): string {
  store.clear();
  const location = { pathname: '/', search: '', hash };
  g.window = {
    location,
    history: {
      replaceState: (_s, _t, url) => {
        const hashAt = url.indexOf('#');
        const path = hashAt === -1 ? url : url.slice(0, hashAt);
        const queryAt = path.indexOf('?');
        location.pathname = queryAt === -1 ? path : path.slice(0, queryAt);
        location.search = queryAt === -1 ? '' : path.slice(queryAt);
        location.hash = hashAt === -1 ? '' : url.slice(hashAt);
      },
    },
    localStorage: storage,
    sessionStorage: storage,
    Telegram: {
      WebApp: {
        initData: 'x',
        initDataUnsafe: sdkStartParam ? { start_param: sdkStartParam } : {},
        colorScheme: 'dark',
        themeParams: {},
        ready() {},
        expand() {},
        setHeaderColor() {},
        setBackgroundColor() {},
        onEvent() {},
      },
    },
  };
  initTelegramWebApp();
  return location.pathname + location.search + location.hash;
}

it('Telegram, e_greetings__r_<код>: мастер поздравления и код приглашения', () => {
  const url = launch(
    `#tgWebAppData=x&tgWebAppStartParam=e_greetings__r_${CODE}`
  );
  assert.equal(url, '/?entry=greetings#/projects/new');
  assert.equal(storedReferralCode(), CODE);
});

it('Telegram, e_site-tutorial: мастер обучалки', () => {
  assert.equal(
    launch('#tgWebAppData=x&tgWebAppStartParam=e_site-tutorial'),
    '/?entry=site-tutorial#/projects/new'
  );
  assert.equal(storedReferralCode(), null);
});

it('Telegram, параметр только в initDataUnsafe.start_param', () => {
  assert.equal(launch('#tgWebAppData=x', 'e_ads'), '/?entry=ads#/projects/new');
});

it('Telegram, r_<код> без сценария: адрес не трогается, код запомнен', () => {
  assert.equal(launch(`#tgWebAppData=x&tgWebAppStartParam=r_${CODE}`), '/');
  assert.equal(storedReferralCode(), CODE);
});

it('Telegram, мусор в startapp: обычный старт, ничего не запомнено', () => {
  assert.equal(
    launch(`#tgWebAppData=x&tgWebAppStartParam=e_shop__r_${CODE}`),
    '/'
  );
  assert.equal(storedReferralCode(), null);
});

it('Telegram, cst_<сайт>: ссылка помощника сильнее и не путается с e_', () => {
  assert.equal(
    launch('#tgWebAppData=x&tgWebAppStartParam=cst_site42'),
    '/?entry=site-tutorial#/projects/new'
  );
});

it('браузер: ?ref= и составной параметр — код берётся из ?ref= первым', () => {
  store.clear();
  g.window.location = {
    pathname: '/',
    search: '?ref=WXYZ6789',
    hash: `#tgWebAppStartParam=e_ads__r_${CODE}`,
  };
  captureReferralCode();
  assert.equal(storedReferralCode(), 'WXYZ6789');
});

console.log(`\n${passed} проверок пройдено`);
