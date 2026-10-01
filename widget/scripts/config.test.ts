/**
 * Повторная проверка конфига вида на клиенте (ТЗ §3-бис.1, аудит 01.10;
 * приёмка 5а): цвет-инъекция → умолчание, enum вне перечня → умолчание,
 * тексты — данные с лимитом, картинки — только id, hosts — только origin;
 * контраст «авто» ≥ 4.5:1 для любого цвета (приёмка п.3 «контраст»);
 * маски путей; preview-патч без hosts.
 */
import assert from 'node:assert/strict';
import {
  applyPreviewPatch,
  contrast,
  defaultViewConfig,
  mergeView,
  onColor,
  parsePublicConfig,
  pathMatches,
  shownOn,
} from '../src/shared/config';

const d = defaultViewConfig();

// 5а: цвет `red;background:url(//x)` — не HEX → умолчание
const inj = mergeView(d, {
  brand: {
    primaryColor: 'red;background:url(//x)',
    buttonTextColor: '#fff;x',
    name: '<img src=x onerror=alert(1)>',
    font: 'Comic Sans',
    preset: 'evil',
    theme: 'neon',
    launcherIcon: 'skull',
    logoAssetId: '../../etc/passwd',
    avatar: { kind: 'url', url: 'https://evil/x.png' },
    css: 'body{display:none}',
  },
  layout: {
    position: 'center',
    zIndex: 1e12,
    offset: { desktop: { x: -5, y: 9999 } },
    mobile: 'popup',
  },
});
assert.equal(
  inj.brand.primaryColor,
  d.brand.primaryColor,
  'цвет-инъекция → умолчание'
);
assert.equal(inj.brand.buttonTextColor, d.brand.buttonTextColor);
assert.equal(
  inj.brand.name,
  '<img src=x onerror=alert(1)>',
  'имя хранится как ТЕКСТ (в DOM — textContent)'
);
assert.equal(inj.brand.font, 'system');
assert.equal(inj.brand.preset, 'soft');
assert.equal(inj.brand.theme, 'auto');
assert.equal(inj.brand.launcherIcon, 'chat');
assert.equal(inj.brand.logoAssetId, null, 'не id ассета');
assert.deepEqual(
  inj.brand.avatar,
  d.brand.avatar,
  'внешний URL аватара не принят'
);
assert.equal(
  (inj.brand as unknown as Record<string, unknown>).css,
  undefined,
  'пользовательского CSS нет'
);
assert.equal(inj.layout.position, 'bottom-right');
assert.equal(inj.layout.zIndex, d.layout.zIndex);
assert.deepEqual(inj.layout.offset.desktop, d.layout.offset.desktop);
assert.equal(inj.layout.mobile, 'fullscreen');

const okv = mergeView(d, {
  brand: {
    primaryColor: '#AbCdEf',
    name: 'x'.repeat(50),
    logoAssetId: 'as_123',
    avatar: { kind: 'asset', assetId: 'av_1' },
  },
  texts: {
    ru: { greeting: 'Привет', suggestions: ['a', 'b', 'c', 'd', 5] },
    de: { greeting: 'Hallo' },
  },
  layout: {
    position: 'top-left',
    zIndex: 10,
    offset: { mobile: { x: 0, y: 200 } },
  },
});
assert.equal(okv.brand.primaryColor, '#AbCdEf');
assert.equal(okv.brand.name.length, 30, 'имя ≤ 30');
assert.equal(okv.brand.logoAssetId, 'as_123');
assert.deepEqual(okv.brand.avatar, { kind: 'asset', assetId: 'av_1' });
assert.deepEqual(okv.texts.ru, {
  greeting: 'Привет',
  suggestions: ['a', 'b', 'c'],
});
assert.equal(
  (okv.texts as Record<string, unknown>).de,
  undefined,
  'язык вне uk/ru/en'
);
assert.equal(okv.layout.position, 'top-left');
assert.deepEqual(okv.layout.offset.mobile, { x: 0, y: 200 });

// публичный конфиг целиком
const pc = parsePublicConfig({
  status: 'lead_only',
  widgetVersion: 7,
  config: { brand: { primaryColor: '#000000' } },
  hosts: [
    {
      origin: 'https://shop.ua',
      pathMasks: ['/catalog/*', 'nope'],
      hideOn: ['/checkout*'],
    },
    { origin: 'https://shop.ua/path' },
    { origin: 'javascript:alert(1)' },
  ],
  allowClientPreview: 'yes',
  lead: {
    fields: [
      { field: 'phone', required: true },
      { field: 'ssn', required: true },
      { field: 'phone' },
    ],
    consentText: { ru: 'Согласен', xx: 'y' },
  },
  suggestedQuestions: ['q1', 2],
  poweredByUrl: 'javascript:alert(1)',
});
assert.equal(pc.status, 'lead_only');
assert.equal(pc.widgetVersion, 7);
assert.deepEqual(pc.hosts, [
  {
    origin: 'https://shop.ua',
    pathMasks: ['/catalog/*'],
    hideOn: ['/checkout*'],
  },
]);
assert.equal(pc.allowClientPreview, false, 'флаг — только true');
assert.deepEqual(pc.lead.fields, [{ field: 'phone', required: true }]);
assert.deepEqual(pc.lead.consentText, { ru: 'Согласен' });
assert.deepEqual(pc.suggestedQuestions, ['q1']);
assert.equal(pc.poweredByUrl, null, 'Powered by — только https');
assert.equal(parsePublicConfig(null).status, 'active');
assert.equal(parsePublicConfig({ status: 'weird' }).status, 'active');

// preview («к Л2»): hosts не принимается, остальное — те же правила
const pv = applyPreviewPatch(d, {
  brand: { primaryColor: '#ff0000' },
  hosts: [{ hostId: 'h' }],
});
assert.equal(pv.brand.primaryColor, '#ff0000');
assert.equal((pv as unknown as Record<string, unknown>).hosts, undefined);

// контраст «авто»: для любого фона ≥ 4.5:1 (перебор по сетке цветов)
let worst = 21;
for (let r = 0; r < 256; r += 15)
  for (let g = 0; g < 256; g += 15)
    for (let b = 0; b < 256; b += 15) {
      const hex =
        '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
      worst = Math.min(worst, contrast(hex, onColor(hex, 'auto')));
    }
assert.ok(worst >= 4.5, `худший контраст «авто» ${worst.toFixed(2)} < 4.5`);
assert.equal(
  onColor('#ffff00', '#ffffff'),
  '#000000',
  'заданный цвет без AA → авто'
);
assert.equal(onColor('#1f5fd6', '#ffffff'), '#ffffff');
assert.ok(contrast('#000000', '#ffffff') > 20.9);

// маски путей и где показывать
assert.ok(pathMatches('/catalog/*', '/catalog/shoes/1'));
assert.ok(!pathMatches('/catalog/*', '/blog'));
assert.ok(pathMatches('/checkout*', '/checkout'));
assert.ok(pathMatches('/a/*/c', '/a/b/c'));
assert.ok(!pathMatches('/a', '/a/b'));
const hosts = {
  hosts: [
    {
      origin: 'https://shop.ua',
      pathMasks: ['/catalog/*'],
      hideOn: ['/catalog/secret*'],
    },
  ],
};
assert.ok(shownOn(hosts, 'https://shop.ua', '/catalog/1', []));
assert.ok(!shownOn(hosts, 'https://shop.ua', '/', []), 'вне масок');
assert.ok(
  !shownOn(hosts, 'https://shop.ua', '/catalog/secret-x', []),
  'hideOn'
);
assert.ok(!shownOn(hosts, 'https://evil.ua', '/catalog/1', []), 'чужой origin');
assert.ok(
  !shownOn({ hosts: [] }, 'https://x', '/checkout', ['/checkout']),
  'data-hide-on'
);
assert.ok(
  shownOn({ hosts: [] }, 'https://x', '/', []),
  'без списка — решает iframe'
);

console.log('config: инъекции бренда, enum, контраст, маски — ок');
