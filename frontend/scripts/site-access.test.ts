/**
 * Режим обучалки A/B и подтверждение прав на аккаунт (Э-С Ш1, П-Т1/П-Т2):
 * правила экрана — когда галочка обязательна, какой текст и на каком языке.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canOfferVerify,
  consentLocaleOf,
  consentText,
  modeReasonKey,
  needsAccountConsent,
  safeVerifyUrl,
  showsVerifyHint,
  siteAccessErrorKey,
  siteModeCardVisible,
} from '../src/lib/site-access';
import type { SiteAccessView } from '../src/types/client-site-tutorial';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const view = (over: Partial<SiteAccessView> = {}): SiteAccessView => ({
  mode: 'B',
  host: 'shop.example.com',
  registrableDomain: 'example.com',
  reason: 'not_registered',
  hostStatus: 'none',
  hostId: null,
  verifyUrl: 'https://t.me/assist_bot?startapp',
  canRegister: true,
  consent: {
    required: true,
    accepted: false,
    textVersion: 'v1',
    legalReviewed: false,
    texts: {
      uk: 'UK {domain}',
      ru: 'RU {domain} и снова {domain}',
      en: 'EN {domain}',
    },
  },
  ...over,
});

console.log('site access (Э-С Ш1)');

it('галочку решает сервер (consent.required), а не режим: B в journal/off — без галочки', () => {
  // Дефект 3 аудита: раньше экран показывал галочку по `mode === 'B'`.
  const journal = view({
    consent: { ...view().consent, policy: 'journal', required: false },
  });
  assert.equal(needsAccountConsent(journal), false);
  assert.equal(
    needsAccountConsent(
      view({ consent: { ...view().consent, policy: 'off', required: false } })
    ),
    false
  );
});

it('required: B без подтверждения — галочка нужна; с подтверждением и в A — нет', () => {
  assert.equal(needsAccountConsent(view()), true);
  assert.equal(
    needsAccountConsent(
      view({ consent: { ...view().consent, accepted: true } })
    ),
    false
  );
  assert.equal(
    needsAccountConsent(
      view({
        mode: 'A',
        reason: null,
        consent: { ...view().consent, required: false },
      })
    ),
    false
  );
  assert.equal(needsAccountConsent(null), false);
});

it('текст — на языке интерфейса, de/es — английский; домен подставлен везде', () => {
  assert.equal(consentText(view(), 'ru'), 'RU example.com и снова example.com');
  assert.equal(consentText(view(), 'uk'), 'UK example.com');
  assert.equal(consentText(view(), 'de'), 'EN example.com');
  assert.equal(consentLocaleOf('es'), 'en');
});

it('причины режима B → ключи словаря; общие — без пояснения', () => {
  assert.equal(modeReasonKey('unavailable'), 'modeReasonUnavailable');
  assert.equal(modeReasonKey('not_verified'), 'modeReasonPending');
  assert.equal(modeReasonKey('role'), 'modeReasonRole');
  assert.equal(modeReasonKey('ip_address'), 'modeReasonIp');
  assert.equal(modeReasonKey('opted_out'), 'modeReasonOptedOut');
  assert.equal(modeReasonKey('no_account'), null);
  assert.equal(modeReasonKey(null), null);
});

it('ссылка на кабинет сайтов — только https', () => {
  assert.equal(
    safeVerifyUrl(view({ verifyUrl: 'https://t.me/x_bot' })),
    'https://t.me/x_bot'
  );
  assert.equal(safeVerifyUrl(view({ verifyUrl: 'javascript:alert(1)' })), null);
  assert.equal(safeVerifyUrl(view({ verifyUrl: 'http://x.example' })), null);
  assert.equal(safeVerifyUrl(null), null);
});

it('«Это мой сайт» — своим диалогом, а не window.confirm (WebView Telegram его блокирует)', () => {
  // Проверка по исходнику, как в client-site-wizard.test.ts: рендер-раннера
  // нет. `window.confirm` в WebView Telegram часто молча возвращает false —
  // кнопка «Это мой сайт» не делала бы ничего (аудит Ш1).
  const src = readFileSync(
    new URL('../src/features/projects/ClientSiteWizard.tsx', import.meta.url),
    'utf8'
  );
  assert.ok(
    !/window\.confirm\(\s*t\.verifySiteConfirm/.test(src),
    'текст согласия на привязку кабинета не должен идти через window.confirm'
  );
  const fnStart = src.indexOf('const registerSite = async');
  assert.ok(fnStart > 0, 'registerSite не найден');
  const fnBody = src.slice(fnStart, src.indexOf('\n  };', fnStart));
  assert.ok(
    !fnBody.includes('window.confirm'),
    'registerSite без window.confirm'
  );
  // Обе плашки режима открывают диалог, а не регистрируют сразу.
  const onVerify = src.match(/onVerify=\{(\w+)\}/g) ?? [];
  assert.equal(onVerify.length, 2);
  for (const m of onVerify) assert.equal(m, 'onVerify={askRegisterSite}');
  // Диалог показывает тот же текст согласия и по «Продолжить» зовёт регистрацию.
  const dlgStart = src.indexOf('<ConfirmDialog\n        open={verifyAsk}');
  assert.ok(dlgStart > 0, 'диалог «Это мой сайт» не найден');
  const dlg = src.slice(dlgStart, src.indexOf('</ConfirmDialog>', dlgStart));
  assert.ok(dlg.includes('onConfirm={() => void registerSite()}'));
  assert.ok(dlg.includes('{t.verifySiteConfirm}'));
  assert.ok(dlg.includes('danger={false}'));
});

const journal = (over: Partial<SiteAccessView> = {}): SiteAccessView =>
  view({
    consent: { ...view().consent, policy: 'journal', required: false },
    ...over,
  });

it('карточка режима: тупиковые причины — не показываем, если «Это мой сайт» некуда вести (дефект 4)', () => {
  for (const reason of [
    'not_configured',
    'no_telegram',
    'no_account',
    'unavailable',
  ] as const) {
    for (const stage of ['url', 'page', 'review'] as const) {
      const dead = { reason, canRegister: false };
      assert.equal(siteModeCardVisible(journal(dead), stage), false);
      assert.equal(siteModeCardVisible(view(dead), stage), false);
    }
  }
});

it('no_account: кнопка «Это мой сайт» есть — /verify-site создаёт кабинет (решение 02.10.2026)', () => {
  const noAccount = journal({ reason: 'no_account', canRegister: true });
  assert.equal(canOfferVerify(noAccount), true);
  assert.equal(siteModeCardVisible(noAccount, 'url'), true);
  assert.equal(siteModeCardVisible(noAccount, 'review'), true);
  // Экран записи — без плашки, как и у остальных причин в journal.
  assert.equal(siteModeCardVisible(noAccount, 'page'), false);
  // Нет SITES_VERIFY_URL — подтверждать негде: ни кнопки, ни карточки.
  const nowhere = journal({
    reason: 'no_account',
    canRegister: true,
    verifyUrl: null,
  });
  assert.equal(canOfferVerify(nowhere), false);
  assert.equal(siteModeCardVisible(nowhere, 'url'), false);
});

it('«Это мой сайт» без ссылки подтверждения (SITES_VERIFY_URL не задан или не https) — не предлагаем', () => {
  assert.equal(canOfferVerify(journal({ verifyUrl: null })), false);
  assert.equal(
    canOfferVerify(journal({ verifyUrl: 'http://t.me/assist_bot' })),
    false
  );
  assert.equal(canOfferVerify(journal()), true);
});

it('карточка режима: journal/off — не на экране страницы (кадр 2 лендинга без плашки); required — везде', () => {
  assert.equal(siteModeCardVisible(journal(), 'url'), true);
  assert.equal(siteModeCardVisible(journal(), 'review'), true);
  assert.equal(siteModeCardVisible(journal(), 'page'), false);
  assert.equal(
    siteModeCardVisible(
      journal({ mode: 'A', reason: null, hostId: 'h' }),
      'page'
    ),
    false
  );
  assert.equal(siteModeCardVisible(view(), 'page'), true);
  assert.equal(siteModeCardVisible(null, 'url'), false);
});

it('«Это мой сайт» — только если сервер разрешил и хоста ещё нет (дефект 12)', () => {
  assert.equal(canOfferVerify(journal()), true);
  assert.equal(canOfferVerify(journal({ canRegister: false })), false);
  assert.equal(canOfferVerify(journal({ hostId: 'h' })), false);
  assert.equal(
    canOfferVerify(journal({ mode: 'A', reason: null, hostId: null })),
    false
  );
  // Подсказка «можно подтвердить» — только когда путь есть.
  assert.equal(showsVerifyHint(journal()), true);
  assert.equal(showsVerifyHint(journal({ hostId: 'h' })), true);
  assert.equal(
    showsVerifyHint(journal({ canRegister: false, reason: 'ip_address' })),
    false
  );
});

it('коды отказов режима — ключи словаря, а не русский текст сервера (дефект 7)', () => {
  assert.equal(
    siteAccessErrorKey('SITE_TUTORIAL_SITES_NO_TELEGRAM'),
    'verifyErrNoTelegram'
  );
  assert.equal(
    siteAccessErrorKey('SITE_TUTORIAL_SITES_UNAVAILABLE'),
    'verifyErrUnavailable'
  );
  assert.equal(
    siteAccessErrorKey('SITE_TUTORIAL_SITES_ACCOUNT_ROLE_REQUIRED'),
    'verifyErrRole'
  );
  assert.equal(
    siteAccessErrorKey('SITE_TUTORIAL_SITES_HOST_OPTED_OUT'),
    'verifyErrOptedOut'
  );
  assert.equal(
    siteAccessErrorKey('SITE_TUTORIAL_SITES_HOST_INVALID'),
    'verifyErrInvalid'
  );
  assert.equal(
    siteAccessErrorKey('SITE_TUTORIAL_SITES_HOST_DUPLICATE'),
    'verifyErrGeneric'
  );
  assert.equal(
    siteAccessErrorKey('SITE_TUTORIAL_ACCOUNT_CONSENT_REQUIRED'),
    'consentErrRequired'
  );
  assert.equal(
    siteAccessErrorKey('SITE_TUTORIAL_CONSENT_VERSION_STALE'),
    'consentErrStale'
  );
  assert.equal(siteAccessErrorKey('PROJECT_NOT_FOUND'), null);
  assert.equal(siteAccessErrorKey(null), null);
});

it('словари: все ключи режима в пяти локалях, без «чужого сайта» и обещания снять ограничения', () => {
  const keys = [
    'modeATitle',
    'modeAText',
    'modeBTitle',
    'modeBText',
    'modeBTextRequired',
    'modeBVerifyHint',
    'modeReasonUnavailable',
    'modeReasonPending',
    'modeReasonExpired',
    'modeReasonRevoked',
    'modeReasonRole',
    'modeReasonOptedOut',
    'modeReasonUnsupported',
    'modeReasonIp',
    'consentFirst',
    'verifyErrNoTelegram',
    'verifyErrUnavailable',
    'verifyErrRole',
    'verifyErrOptedOut',
    'verifyErrInvalid',
    'verifyErrGeneric',
    'consentErrRequired',
    'consentErrStale',
  ];
  const banned =
    /чуж|someone else|fremde|ajeno|ограничени.*сним|обмеження.*зним|lift .*limits|Einschränkungen aufzuheben|quitar los límites/i;
  for (const loc of ['ru', 'uk', 'en', 'de', 'es']) {
    const dict = JSON.parse(
      readFileSync(
        new URL(`../src/dictionaries/${loc}.json`, import.meta.url),
        'utf8'
      )
    ) as { clientSiteWizard: Record<string, string> };
    const w = dict.clientSiteWizard;
    for (const k of keys) {
      assert.ok(typeof w[k] === 'string' && w[k].length > 0, `${loc}.${k}`);
      assert.ok(!banned.test(w[k]), `${loc}.${k}: «${w[k]}»`);
    }
    for (const k of ['modeBText', 'modeBTextRequired', 'modeAText']) {
      assert.ok(w[k].includes('{host}') || k === 'modeAText', `${loc}.${k}`);
    }
  }
});

it('мастер: повторное «Открыть» без галочки говорит, куда смотреть; отказы — по коду', () => {
  const src = readFileSync(
    new URL('../src/features/projects/ClientSiteWizard.tsx', import.meta.url),
    'utf8'
  );
  const fnStart = src.indexOf('const explore = async');
  const fnBody = src.slice(fnStart, src.indexOf('\n  };', fnStart));
  assert.ok(
    /if \(needsAccountConsent\(current\)\) \{\s*(\/\/[^\n]*\n\s*)*setNotice\(t\.consentFirst\);\s*return;/.test(
      fnBody
    ),
    'explore без галочки обязан показать подсказку, а не молча выйти'
  );
  const runStart = src.indexOf('async function run<T>');
  const runBody = src.slice(runStart, src.indexOf('\n  }\n', runStart));
  assert.ok(runBody.includes('siteAccessErrorKey(code)'));
  assert.ok(runBody.includes('localized ? t[localized] : errorMessage(err)'));
  // Карточка режима — только через siteModeCardVisible (кадр 2 лендинга).
  const cards = src.match(/<SiteModeCard\b/g) ?? [];
  assert.equal(cards.length, 2);
  assert.equal((src.match(/siteModeCardVisible\(access, /g) ?? []).length, 3);
});

console.log(`\n${passed} проверок пройдено`);
