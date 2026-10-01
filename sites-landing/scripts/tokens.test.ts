/**
 * Система токенов (§12): контраст текста ≥ 4.5:1 и фокуса ≥ 3:1 в
 * светлой и тёмной теме. Значения читаются прямо из `globals.css`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'globals.css'), 'utf8');

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [m[1], m[2]]));
}
const light = tokens(/:root\s*\{([\s\S]*?)\n\}/.exec(css)![1]);
const darkBlock = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}/.exec(css);
assert.ok(darkBlock, 'нет тёмной темы');
const dark = { ...light, ...tokens(darkBlock[1]) };

function lum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT_PAIRS: Array<[string, string]> = [
  ['text', 'bg'], ['text', 'surface'], ['muted', 'bg'], ['muted', 'surface'],
  ['link', 'bg'], ['link', 'surface'], ['link', 'banner-bg'], ['accent-text', 'accent'],
  ['soon-text', 'soon-bg'], ['banner-text', 'banner-bg'], ['error-text', 'bg'], ['error-text', 'surface'],
  ['ok-text', 'surface'], ['ok-text', 'bg'],
];
const UI_PAIRS: Array<[string, string]> = [['focus', 'bg'], ['focus', 'surface'], ['muted', 'bg']];

const report: string[] = [];
for (const [name, theme] of [['светлая', light], ['тёмная', dark]] as const) {
  for (const [fg, bg] of TEXT_PAIRS) {
    assert.ok(theme[fg] && theme[bg], `${name}: нет токена ${fg} или ${bg}`);
    const c = contrast(theme[fg], theme[bg]);
    assert.ok(c >= 4.5, `${name}: ${fg} на ${bg} — ${c.toFixed(2)}:1 < 4.5`);
    report.push(c.toFixed(1));
  }
  for (const [fg, bg] of UI_PAIRS) {
    const c = contrast(theme[fg], theme[bg]);
    assert.ok(c >= 3, `${name}: ${fg} на ${bg} — ${c.toFixed(2)}:1 < 3 (граница/фокус)`);
  }
}
assert.ok(contrast('#777777', '#ffffff') < 4.5, 'самопроверка формулы');
console.log(`ok   токены: ${TEXT_PAIRS.length} пар текста × 2 темы ≥ 4.5:1 (минимум ${Math.min(...report.map(Number))}:1), фокус и границы полей ≥ 3:1`);
