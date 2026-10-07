/**
 * Обучалка по сайту заказчика — заход 7, пакет B: отказы по коду (П-Т6,
 * П-Т8, П-Т9, П-Т11, П-Т13, частота «Это мой сайт»), тело «опасного»
 * клика, плашка «привязано к помощнику» (ответы `assist-link` — мок) и
 * свои диалоги вместо `window.confirm` в мастере.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DANGER_CONFIRM_REQUIRED,
  LOGIN_ATTEMPTS_EXCEEDED,
  LOGIN_IDENTITIES_EXCEEDED,
  SITE_OPTED_OUT,
  TUTORIAL_TEMPORARILY_UNAVAILABLE,
  VERIFY_SITE_RATE_LIMITED,
  assistLinkCardMode,
  normalizeAssistLink,
  stepFieldRejected,
  recordingBlocked,
  siteAccessErrorKey,
  stepClick,
  withMinutes,
} from '../src/lib/site-access';
import type { SiteAccessView } from '../src/types/client-site-tutorial';

let passed = 0;
function it(name: string, fn: () => void | Promise<void>) {
  const r = fn();
  if (r instanceof Promise) throw new Error(`${name}: только синхронно`);
  passed += 1;
  console.log('  ✓', name);
}

const wizard = readFileSync(
  new URL('../src/features/projects/ClientSiteWizard.tsx', import.meta.url),
  'utf8'
);
const api = readFileSync(
  new URL('../src/services/client-site-tutorial-api.ts', import.meta.url),
  'utf8'
);

console.log('обучалка: доступ, лимиты, мастер (заход 7, пакет B)');

it('п.5б: старый backend отклонил новые поля /step — узнаём по телу 400', () => {
  const reject = (fields: string[]) => ({
    error: {
      code: 'BAD_REQUEST',
      message: `property ${fields[0]} should not exist`,
      details: { message: fields.map((f) => `property ${f} should not exist`) },
    },
  });
  assert.equal(
    stepFieldRejected(reject(['clickText']), ['clickText', 'confirmDanger']),
    true
  );
  assert.equal(
    stepFieldRejected(reject(['confirmDanger']), [
      'clickText',
      'confirmDanger',
    ]),
    true
  );
  // Другая 400 (не про наши поля) — не повод для повтора.
  assert.equal(
    stepFieldRejected({ error: { message: 'url should not exist' } }, [
      'clickText',
      'confirmDanger',
    ]),
    false
  );
  // Поля упомянуты, но без «should not exist» (например, нормальная ошибка) — нет.
  assert.equal(
    stepFieldRejected({ error: { message: 'clickText too long' } }, [
      'clickText',
    ]),
    false
  );
  assert.equal(stepFieldRejected(null, ['clickText']), false);
});

it('п.5б: stepSite повторяет /step без новых полей при whitelist-400', () => {
  const src = readFileSync(
    new URL('../src/services/client-site-tutorial-api.ts', import.meta.url),
    'utf8'
  );
  assert.ok(src.includes('УБРАТЬ ПОСЛЕ 2026-11-06'), 'помечен срок удаления');
  assert.ok(
    /stepFieldRejected\(err\.response\?\.data, \['clickText', 'confirmDanger'\]\)/.test(
      src
    ),
    'повтор завязан на распознавание отклонённых полей'
  );
  assert.ok(
    /const \{ clickText, confirmDanger, \.\.\.legacy \} = input;/.test(src),
    'повтор уходит без clickText/confirmDanger'
  );
});

it('коды отказов — ключи словаря; ключи прототипа объекта — не коды', () => {
  assert.equal(siteAccessErrorKey(SITE_OPTED_OUT), 'recordErrOptedOut');
  assert.equal(
    siteAccessErrorKey(TUTORIAL_TEMPORARILY_UNAVAILABLE),
    'recordErrUnavailable'
  );
  assert.equal(siteAccessErrorKey(LOGIN_ATTEMPTS_EXCEEDED), 'loginErrAttempts');
  assert.equal(
    siteAccessErrorKey(LOGIN_IDENTITIES_EXCEEDED),
    'loginErrIdentities'
  );
  assert.equal(
    siteAccessErrorKey(VERIFY_SITE_RATE_LIMITED),
    'verifyErrRateLimited'
  );
  assert.equal(siteAccessErrorKey(DANGER_CONFIRM_REQUIRED), 'dangerErrConfirm');
  // Коды сервера — те же строки, что в backend (контракт).
  assert.equal(SITE_OPTED_OUT, 'SITE_TUTORIAL_SITE_OPTED_OUT');
  assert.equal(
    DANGER_CONFIRM_REQUIRED,
    'SITE_TUTORIAL_DANGER_CONFIRM_REQUIRED'
  );
  for (const junk of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
    assert.equal(siteAccessErrorKey(junk), null, junk);
  // Прежние коды «Это мой сайт» не сломаны новым разбором.
  assert.equal(
    siteAccessErrorKey('SITE_TUTORIAL_SITES_HOST_OPTED_OUT'),
    'verifyErrOptedOut'
  );
});

it('{minutes}: вверх и не меньше одной; без срока — заглушка', () => {
  assert.equal(
    withMinutes('через {minutes} мин', 29 * 60_000 + 1),
    'через 30 мин'
  );
  assert.equal(withMinutes('через {minutes} мин', 1), 'через 1 мин');
  assert.equal(withMinutes('через {minutes} мин', null), 'через … мин');
  assert.equal(withMinutes('без срока', 60_000), 'без срока');
});

it('П-Т13: тело клика — подтверждение только после диалога, текст кнопки ≤ 300', () => {
  const el = {
    selector: '#pay',
    tag: 'button' as const,
    visibleText: '  Оплатить  ',
    danger: 'оплата',
  };
  assert.deepEqual(stepClick(el, false), {
    clickSelector: '#pay',
    clickText: 'Оплатить',
  });
  assert.deepEqual(stepClick(el, true), {
    clickSelector: '#pay',
    clickText: 'Оплатить',
    confirmDanger: true,
  });
  const long = stepClick(
    { selector: '#x', tag: 'a', label: 'я'.repeat(500) },
    false
  );
  assert.equal(long.clickText.length, 300);
  // Текста нет — clickText всё равно шлём пустым (признак нового клиента).
  assert.deepEqual(stepClick({ selector: '#i', tag: 'button' }, false), {
    clickSelector: '#i',
    clickText: '',
  });
});

it('П-Т11: запись закрыта только у B с причиной opted_out', () => {
  const v = (over: Partial<SiteAccessView>) => ({ ...base, ...over });
  const base = {
    mode: 'B',
    reason: 'opted_out',
  } as unknown as SiteAccessView;
  assert.equal(recordingBlocked(v({})), true);
  assert.equal(recordingBlocked(v({ reason: 'not_verified' })), false);
  assert.equal(recordingBlocked(v({ mode: 'A', reason: null })), false);
  assert.equal(recordingBlocked(null), false);
});

it('assist-link: ответы сервера (мок) → плашка', () => {
  // Мок ответов `GET/POST …/assist-link` по контракту пакета C.
  const responses: Record<string, unknown> = {
    linked: {
      linked: true,
      siteId: 's1',
      siteName: 'Ромашка',
      canLink: false,
      candidates: [],
    },
    pick: {
      linked: false,
      siteId: null,
      siteName: null,
      canLink: true,
      candidates: [
        { siteId: 's1', name: 'Ромашка' },
        { siteId: 's2' },
        { name: 'без id' },
        null,
      ],
    },
    noRights: {
      linked: false,
      siteId: null,
      siteName: null,
      canLink: false,
      candidates: [],
    },
    emptyButCan: {
      linked: false,
      siteId: null,
      siteName: null,
      canLink: true,
      candidates: [],
    },
    legacy: { clientSiteId: 'old1', siteName: 'Старый' },
    legacyNone: { clientSiteId: null },
    junk: 'мусор',
  };
  const get = (k: string) => normalizeAssistLink(responses[k]);

  assert.deepEqual(get('linked'), {
    linked: true,
    siteId: 's1',
    siteName: 'Ромашка',
    canLink: false,
    candidates: [],
  });
  assert.equal(assistLinkCardMode(get('linked')), 'linked');

  const pick = get('pick');
  assert.deepEqual(pick.candidates, [
    { siteId: 's1', name: 'Ромашка' },
    { siteId: 's2', name: 's2' },
  ]);
  assert.equal(assistLinkCardMode(pick), 'pick');

  assert.equal(assistLinkCardMode(get('noRights')), 'hidden');
  assert.equal(assistLinkCardMode(get('emptyButCan')), 'hidden');
  assert.deepEqual(get('legacy'), {
    linked: true,
    siteId: 'old1',
    siteName: 'Старый',
    canLink: false,
    candidates: [],
  });
  assert.equal(assistLinkCardMode(get('legacyNone')), 'hidden');
  assert.equal(assistLinkCardMode(get('junk')), 'hidden');
  assert.equal(assistLinkCardMode(null), 'hidden');
});

it('assist-link: клиент — GET и POST { siteId } на маршрут черновика', () => {
  assert.ok(
    /api\.get<unknown>\(`\$\{base\(projectId\)\}\/assist-link`\)/.test(api),
    'GET …/assist-link'
  );
  assert.ok(
    /api\.post<unknown>\(`\$\{base\(projectId\)\}\/assist-link`, \{\s*siteId,\s*\}\)/.test(
      api
    ),
    'POST …/assist-link { siteId }'
  );
  assert.ok(
    api.includes("ASSIST_LINK_UNAVAILABLE = 'ASSIST_LINK_UNAVAILABLE'")
  );
});

it('мастер: ни одного window.confirm — свои диалоги удаления и выключения советов', () => {
  assert.ok(!/window\.confirm\(/.test(wizard), 'window.confirm(');
  assert.ok(/open=\{discardAsk\}/.test(wizard), 'диалог удаления');
  assert.ok(/open=\{guideOffAsk\}/.test(wizard), 'диалог выключения советов');
  const discard = wizard.slice(
    wizard.indexOf('const confirmDiscard = async'),
    wizard.indexOf('\n  };', wizard.indexOf('const confirmDiscard = async'))
  );
  assert.ok(discard.includes('deleteSiteTutorial(projectId)'));
});

it('мастер: «опасная» кнопка — диалог, затем stepClick(el, true); 409 сервера открывает тот же диалог', () => {
  assert.ok(wizard.includes('props.onStep(stepClick(el, true))'));
  assert.ok(wizard.includes(': props.onStep(stepClick(el, false))'));
  const fn = wizard.slice(
    wizard.indexOf('const submitStep = async'),
    wizard.indexOf('\n  };', wizard.indexOf('const submitStep = async'))
  );
  assert.ok(/failure\.code === DANGER_CONFIRM_REQUIRED/.test(fn));
  assert.ok(/setConfirming\(/.test(fn));
});

it('мастер: домен закрыт владельцем — «Открыть» не ведёт никуда', () => {
  const fn = wizard.slice(
    wizard.indexOf('const explore = async'),
    wizard.indexOf('\n  };', wizard.indexOf('const explore = async'))
  );
  assert.ok(
    /if \(recordingBlocked\(current\)\) \{\s*setError\(t\.recordErrOptedOut\);\s*return;/.test(
      fn
    )
  );
});

it('словари: новые ключи в пяти локалях, плейсхолдеры на месте', () => {
  const keys = [
    'verifyErrRateLimited',
    'recordErrOptedOut',
    'recordErrUnavailable',
    'loginErrAttempts',
    'loginErrIdentities',
    'dangerErrConfirm',
    'assistLinkedTitle',
    'assistLinkedText',
    'assistLinkTitle',
    'assistLinkHint',
    'assistLinkSite',
    'assistLinkButton',
    'assistLinkDone',
    'assistLinkErrUnavailable',
    'modeReasonOptedOut',
  ];
  for (const loc of ['ru', 'uk', 'en', 'de', 'es']) {
    const w = (
      JSON.parse(
        readFileSync(
          new URL(`../src/dictionaries/${loc}.json`, import.meta.url),
          'utf8'
        )
      ) as { clientSiteWizard: Record<string, string> }
    ).clientSiteWizard;
    for (const k of keys)
      assert.ok(typeof w[k] === 'string' && w[k].length > 0, `${loc}.${k}`);
    for (const k of ['loginErrAttempts', 'verifyErrRateLimited'])
      assert.ok(w[k].includes('{minutes}'), `${loc}.${k}: {minutes}`);
    assert.ok(w.assistLinkedText.includes('{site}'), `${loc}.assistLinkedText`);
  }
  // П-Т11: отказ домена больше НЕ «не мешает записи».
  const ru = JSON.parse(
    readFileSync(
      new URL('../src/dictionaries/ru.json', import.meta.url),
      'utf8'
    )
  ) as { clientSiteWizard: Record<string, string> };
  assert.ok(!/не мешает/.test(ru.clientSiteWizard.modeReasonOptedOut));
});

console.log(`site-tutorial-limits: ${passed} проверок — ок`);
