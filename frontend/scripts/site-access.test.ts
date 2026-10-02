/**
 * Режим обучалки A/B и подтверждение прав на аккаунт (Э-С Ш1, П-Т1/П-Т2):
 * правила экрана — когда галочка обязательна, какой текст и на каком языке.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  consentLocaleOf,
  consentText,
  modeReasonKey,
  needsAccountConsent,
  safeVerifyUrl,
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
  verifyUrl: null,
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

it('B без подтверждения — галочка нужна; с подтверждением и в A — нет', () => {
  assert.equal(needsAccountConsent(view()), true);
  assert.equal(
    needsAccountConsent(
      view({ consent: { ...view().consent, accepted: true } })
    ),
    false
  );
  assert.equal(needsAccountConsent(view({ mode: 'A', reason: null })), false);
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

console.log(`\n${passed} проверок пройдено`);
