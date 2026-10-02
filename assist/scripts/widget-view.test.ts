import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import type { AccountMember } from '../src/kit';
import { SETUP_ERROR_CODES } from '../src/lib/setup-errors';
import * as B from '../src/lib/widget-brand';
import {
  PATH_MASK,
  applyLandingDraft,
  assetFileProblem,
  autoTextColor,
  buttonText,
  canManageWidget,
  contrastHint,
  contrastRatio,
  hostRule,
  installTone,
  linesToList,
  normalizeHex,
  parseMasks,
  previewTag,
  withHostRule,
} from '../src/lib/widget-view';
import {
  ASSET_MAX_BYTES,
  WIDGET_COLOR_PRESETS,
  type WidgetConfig,
} from '../src/lib/widget-types';
import * as S from '../../sites-backend/src/modules/assist-site-setup/widget-config';

const BACK = '../../sites-backend/src/';
const member = (
  role: AccountMember['role'],
  assist: AccountMember['productRoles']['assist']
): AccountMember => ({
  memberId: 'm1',
  telegramId: '1',
  role,
  productRoles: { qa: 'none', assist, assistAdmin: 'none' },
});

// ═══ Права: оператор раздела не видит (сервер ответил бы 403) ═════════
assert.equal(canManageWidget(member('owner', 'none')), true);
assert.equal(canManageWidget(member('manager', 'manager')), true);
assert.equal(canManageWidget(member('manager', 'operator')), false);
assert.equal(canManageWidget(member('operator', 'manager')), false);
assert.equal(canManageWidget(member('manager', 'none')), false);

// ═══ Контраст: зеркало сервера даёт те же числа ═════════════════════
let seed = 11;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const hex = () =>
  `#${Math.floor(rnd() * 0xffffff)
    .toString(16)
    .padStart(6, '0')}`.toUpperCase();
for (let i = 0; i < 500; i++) {
  const a = hex();
  const b = hex();
  assert.ok(Math.abs(contrastRatio(a, b) - S.contrastRatio(a, b)) < 1e-9);
  assert.equal(autoTextColor(a), S.autoTextColor(a));
}
// Пресеты: подсказка «ок» и сервер не поправляет (контраст пресетов — AA).
const base = S.defaultWidgetConfig('x');
for (const c of WIDGET_COLOR_PRESETS) {
  const brand = { ...base.brand, primaryColor: c };
  assert.equal(contrastHint(brand).ok, true, c);
  const r = S.parseWidgetConfig({ ...base, brand });
  assert.ok(r.ok && r.adjustments.length === 0, c);
}
// Подсказка совпадает с решением сервера «поправить или нет».
for (let i = 0; i < 300; i++) {
  const text = rnd() < 0.5 ? 'auto' : hex();
  const brand = { ...base.brand, primaryColor: hex(), buttonTextColor: text };
  const r = S.parseWidgetConfig({ ...base, brand });
  assert.ok(r.ok);
  const adjusted =
    !r.ok || r.adjustments.some((a) => a.reason.startsWith('contrast_'));
  assert.equal(contrastHint(brand).ok, !adjusted, JSON.stringify(brand));
}
assert.equal(buttonText({ ...base.brand, primaryColor: '#FFFF00' }), '#000000');
assert.equal(
  buttonText({ ...base.brand, buttonTextColor: '#123456' }),
  '#123456'
);
assert.equal(normalizeHex('#abc'), '#AABBCC');
assert.equal(normalizeHex('7c3aed'), '#7C3AED');
for (const bad of ['red', '#12345', 'red;background:url(//x)', '#GGGGGG']) {
  assert.equal(normalizeHex(bad), null);
}

// ═══ Маски путей — то же правило, что у сервера ══════════════════════
assert.equal(PATH_MASK.source, /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/.source);
const serverMask = readFileSync(
  new URL(`${BACK}modules/assist-site-setup/widget-config.ts`, import.meta.url),
  'utf8'
).match(/export const PATH_MASK = (\/.*\/);/)![1];
assert.equal(`/${PATH_MASK.source}/`, serverMask);
assert.deepEqual(
  parseMasks('/catalog/*, /sale\n\n/catalog/*, javascript:x, x'),
  {
    masks: ['/catalog/*', '/sale'],
    bad: ['javascript:x', 'x'],
  }
);
assert.deepEqual(linesToList(' a \n\nb\na\nc', 2), ['a', 'b']);

// ═══ Черновик ═══════════════════════════════════════════════════════
const cfg: WidgetConfig = { ...(base as WidgetConfig), hosts: [] };
assert.deepEqual(hostRule(cfg, 'h1'), {
  hostId: 'h1',
  enabled: false,
  pathMasks: [],
  hideOn: [],
});
const c2 = withHostRule(cfg, {
  hostId: 'h1',
  enabled: true,
  pathMasks: ['/a'],
  hideOn: [],
});
assert.equal(
  withHostRule(c2, { ...hostRule(c2, 'h1'), enabled: false }).hosts.length,
  1
);

// Черновик лендинга: вид — его, хосты и картинки — свои.
const mine: WidgetConfig = {
  ...cfg,
  brand: {
    ...cfg.brand,
    logoAssetId: 'logo1',
    avatar: { kind: 'asset', assetId: 'av1' },
  },
  hosts: [{ hostId: 'h1', enabled: true, pathMasks: [], hideOn: [] }],
};
const landing: WidgetConfig = {
  ...cfg,
  brand: { ...cfg.brand, primaryColor: '#DB2777', name: 'Лендинг' },
  layout: { ...cfg.layout, position: 'top-left' },
};
const applied = applyLandingDraft(mine, landing);
assert.equal(applied.brand.primaryColor, '#DB2777');
assert.equal(applied.brand.name, 'Лендинг');
assert.equal(applied.layout.position, 'top-left');
assert.equal(applied.brand.logoAssetId, 'logo1');
assert.deepEqual(applied.hosts, mine.hosts);
assert.ok(S.parseWidgetConfig(applied).ok);

// ═══ Картинка до загрузки ═══════════════════════════════════════════
assert.equal(assetFileProblem({ type: 'image/png', size: 10 }), null);
assert.equal(assetFileProblem({ type: 'image/svg+xml', size: 10 }), 'type');
assert.equal(
  assetFileProblem({ type: 'image/png', size: ASSET_MAX_BYTES + 1 }),
  'size'
);
assert.equal(installTone('ok'), 'success');
assert.equal(installTone('csp_blocked'), 'warning');
assert.equal(installTone('fetch_failed'), 'danger');

// ═══ Тег предпросмотра — только из проверенных частей ═══════════════
const PK = 'pk_live_ABCDEFGHIJKLMNOPQRSTUVWX';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
assert.deepEqual(previewTag('https://w.v4c.example.invalid', PK, TOKEN), {
  src: `https://w.v4c.example.invalid${B.WIDGET_LOADER_PATH}`,
  site: PK,
  token: TOKEN,
});
assert.equal(previewTag('http://w.evil', PK, TOKEN), null);
assert.equal(previewTag(undefined, PK, TOKEN), null);
assert.equal(previewTag('https://w.x', 'pk_live_"><script>', TOKEN), null);
assert.equal(previewTag('https://w.x', null, TOKEN), null);
assert.equal(previewTag('https://w.x', PK, 'x"y'), null);

// ═══ Зеркало публичных имён виджета (sites-backend/src/brand.ts) ════
const brandSrc = readFileSync(
  new URL(`${BACK}brand.ts`, import.meta.url),
  'utf8'
);
for (const name of [
  'WIDGET_LOADER_PATH',
  'WIDGET_GLOBAL',
  'WIDGET_ANCHOR',
  'WIDGET_PREVIEW_PARAM',
] as const) {
  const m = new RegExp(`export const ${name} = '([^']+)'`).exec(brandSrc);
  assert.ok(m, `brand.ts: нет ${name}`);
  assert.equal(B[name], m![1], name);
}
// Литералы имён виджета — только в widget-brand.ts (смена бренда В-1).
function walk(dir: URL): URL[] {
  return readdirSync(dir).flatMap((name) => {
    const u = new URL(name, dir);
    if (/\.(ts|tsx)$/.test(name)) return [u];
    if (name.includes('.')) return [];
    return walk(new URL(`${name}/`, dir));
  });
}
const files = walk(new URL('../src/', import.meta.url));
for (const file of files) {
  if (file.pathname.endsWith('/lib/widget-brand.ts')) continue;
  const code = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const n of [
    B.WIDGET_GLOBAL,
    B.WIDGET_ANCHOR,
    B.WIDGET_PREVIEW_PARAM,
    B.WIDGET_LOADER_PATH,
  ]) {
    assert.ok(
      !code.includes(n),
      `${file.pathname}: литерал «${n}» мимо widget-brand.ts`
    );
  }
}
// Экраны Э2: ни HTML-строк в DOM, ни window.confirm (WebView Telegram).
for (const file of files.filter((f) =>
  /\/screens\/widget\/|\/lib\/(widget|persona|wizard)/.test(f.pathname)
)) {
  const code = readFileSync(file, 'utf8');
  for (const bad of [
    'dangerouslySetInnerHTML',
    'innerHTML',
    'outerHTML',
    'insertAdjacentHTML',
    'document.write',
    'window.confirm',
    'srcdoc',
    'eval(',
  ]) {
    assert.ok(!code.includes(bad), `${file.pathname}: ${bad}`);
  }
}

// ═══ Коды ошибок: каждый код сервера W4 (и W5 из контракта) переведён ═
const errSrc = readFileSync(
  new URL(`${BACK}modules/assist-site-setup/errors.ts`, import.meta.url),
  'utf8'
);
const union = /export type SetupCode =([\s\S]*?);/.exec(errSrc)![1];
const serverCodes = [...union.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
for (const c of [...serverCodes, 'WIZARD_DRAFT_LIMIT', 'WIZARD_NOT_STARTED']) {
  assert.ok(
    (SETUP_ERROR_CODES as readonly string[]).includes(c),
    `нет перевода ${c}`
  );
}
for (const d of [appRu, appUk, appEn]) {
  for (const c of SETUP_ERROR_CODES) assert.ok(d.setup.errors[c].trim(), c);
}

console.log('widget-view: ok');
