/**
 * Контраст цветовых токенов (ТЗ §20, §13.6: текст ≥ 4,5:1; границы полей и
 * фокус ≥ 3:1 — WCAG 1.4.11) в светлой и тёмной теме `globals.css`, плюс
 * встроенные цвета страницы 410. axe проверяет отрисованные страницы, этот
 * тест — сами токены (в том числе состояний, которых axe может не увидеть).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(__dirname, '..', 'src/app/globals.css'), 'utf8');
const block = (re: RegExp) => {
  const m = re.exec(css);
  assert.ok(m, `нет блока токенов ${re}`);
  return Object.fromEntries([...m[1].matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((x) => [x[1], x[2]]));
};
const light = block(/^:root\s*\{([^}]*)\}/m);
const dark = block(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/m);

function lum(hex: string) {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT: Array<[string, string]> = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['link', 'bg'],
  ['link', 'surface'],
  ['cta-text', 'cta-bg'],
  ['error', 'bg'],
  ['success', 'bg'],
  ['banner-text', 'banner-bg'],
];
const UI: Array<[string, string]> = [
  ['border', 'bg'],
  ['border', 'surface'],
  ['focus', 'bg'],
  ['error', 'bg'],
];
const rows: string[] = [];
let n = 0;
for (const [name, t] of [
  ['светлая', light],
  ['тёмная', dark],
] as const) {
  assert.deepEqual(Object.keys(t).sort(), Object.keys(light).sort(), `${name}: тот же набор токенов`);
  for (const [fg, bg] of TEXT) {
    const r = contrast(t[fg], t[bg]);
    n++;
    assert.ok(r >= 4.5, `${name}: ${fg} на ${bg} = ${r.toFixed(2)} < 4.5`);
    rows.push(`${name} ${fg}/${bg} ${r.toFixed(2)}`);
  }
  for (const [fg, bg] of UI) {
    const r = contrast(t[fg], t[bg]);
    n++;
    assert.ok(r >= 3, `${name}: ${fg} на ${bg} = ${r.toFixed(2)} < 3 (граница/фокус)`);
  }
}
// Страница 410 — свой инлайн-стиль.
const gone = fs.readFileSync(path.join(__dirname, '..', 'src/lib/status-page.ts'), 'utf8');
const pairs = [...gone.matchAll(/color:(#[0-9a-f]{6});background:(#[0-9a-f]{3,6})/gi)];
assert.equal(pairs.length, 2, 'страница статуса (410/503): светлая и тёмная пара цветов');
for (const p of pairs) {
  const bg = p[2].length === 4 ? `#${[...p[2].slice(1)].map((c) => c + c).join('')}` : p[2];
  n++;
  assert.ok(contrast(p[1], bg) >= 4.5, `страница статуса: ${p[1]} на ${bg}`);
}
const min = Math.min(...rows.map((r) => Number(r.split(' ').pop())));
console.log(
  `ok   tokens: ${n} пар — текст ≥ 4.5:1 (минимум ${min.toFixed(2)}), границы и фокус ≥ 3:1, обе темы, страница 410`,
);
