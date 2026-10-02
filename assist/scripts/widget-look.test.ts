/**
 * Вид виджета в ките (`site-tma-kit/src/widget-look.ts`, интеграция Э3,
 * запрос лендинга Л3) — сверка с серверным `assist-site-setup/
 * widget-config.ts` (чистый модуль — импортом): перечни, лимиты, пресеты,
 * фоны, пороги WCAG и РЕЗУЛЬТАТЫ функций контраста на 3000 цветов.
 * Расхождение = подсказка кабинета/лендинга «цвет пройдёт AA» врёт
 * относительно поправки сервера.
 */
import assert from 'node:assert/strict';
import * as K from '../src/kit/widget-look';
import * as S from '../../sites-backend/src/modules/assist-site-setup/widget-config';
import * as WT from '../src/lib/widget-types';
import * as WV from '../src/lib/widget-view';

for (const name of [
  'WIDGET_POSITIONS',
  'WIDGET_MOBILE_MODES',
  'WIDGET_THEMES',
  'WIDGET_FONTS',
  'WIDGET_PRESETS',
  'WIDGET_LAUNCHER_ICONS',
  'WIDGET_UI_LANGS',
  'WIDGET_TEXT_LIMITS',
  'WIDGET_COLOR_PRESETS',
  'WIDGET_SURFACES',
  'WCAG_AA_TEXT',
  'WCAG_AA_UI',
] as const) {
  assert.deepEqual(K[name], S[name], `${name}: кит ≠ сервер`);
}
assert.equal(K.HEX_COLOR.source, S.HEX_COLOR.source);

// Детерминированный набор цветов: 3000 псевдослучайных + края.
let seed = 0x5eed;
const rnd = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed;
};
const colors = [
  '#000000',
  '#FFFFFF',
  '#777777',
  '#16181D',
  ...S.WIDGET_COLOR_PRESETS,
];
for (let i = 0; i < 3000; i++)
  colors.push(
    '#' + (rnd() & 0xffffff).toString(16).padStart(6, '0').toUpperCase()
  );

for (let i = 0; i < colors.length; i++) {
  const c = colors[i];
  const d = colors[(i * 7 + 3) % colors.length];
  assert.equal(
    K.contrastRatio(c, d),
    S.contrastRatio(c, d),
    `contrast ${c}/${d}`
  );
  assert.equal(K.autoTextColor(c), S.autoTextColor(c), `auto ${c}`);
  const ok = (x: string) => S.contrastRatio(x, d) >= S.WCAG_AA_UI;
  assert.equal(
    K.nearestPassingShade(c, ok),
    S.nearestPassingShade(c, ok),
    `shade ${c}`
  );
  for (const text of ['auto', d]) {
    assert.deepEqual(
      K.widgetThemeColors({ primaryColor: c, buttonTextColor: text }),
      S.widgetThemeColors({ primaryColor: c, buttonTextColor: text }),
      `theme ${c}/${text}`
    );
    assert.equal(K.lightThemePasses(c, text), S.lightThemePasses(c, text));
  }
}
// Нарочное отличие: недописанный цвет на экране — 1, а не исключение.
assert.equal(K.contrastRatio('#12', '#FFFFFF'), 1);
assert.throws(() => S.contrastRatio('#12', '#FFFFFF'));

// TMA берёт вид из кита, а не держит дубль (одни и те же объекты).
assert.equal(WT.WIDGET_SURFACES, K.WIDGET_SURFACES);
assert.equal(WT.WIDGET_COLOR_PRESETS, K.WIDGET_COLOR_PRESETS);
assert.equal(WV.contrastRatio, K.contrastRatio);
assert.equal(WV.autoTextColor, K.autoTextColor);
// Тип: конфиг кабинета — вид кита + хосты/вовлечение.
const look: K.WidgetLook = S.defaultWidgetConfig('Магазин');
const cfg: WT.WidgetConfig = { ...look, hosts: [] };
assert.equal(cfg.brand.primaryColor, look.brand.primaryColor);

console.log(
  'widget-look: кит = сервер (перечни, пороги, контраст на 3000 цветах)'
);
