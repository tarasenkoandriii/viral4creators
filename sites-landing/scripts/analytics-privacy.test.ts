/**
 * Адрес сайта посетителя не уходит третьей стороне (§10.1, §6; аудит фронта
 * 02.10): поле hero ведёт на `/try?url=<сайт>`, а скрипт Vercel Web
 * Analytics по умолчанию шлёт `location.href` целиком.
 *  1. `beforeSend` режет query и якорь (адрес сайта, utm), неразбираемое —
 *     отбрасывает.
 *  2. `HtmlDocument` на Vercel рисует именно обёртку с `beforeSend`, а не
 *     голый `<Analytics />`.
 *  3. Песочница снимает `url` из адреса страницы после чтения
 *     (`withoutUrlParam` → `history.replaceState`), прочие параметры и якорь
 *     остаются; без параметра адрес не трогается.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { analyticsBeforeSend, redactAnalyticsUrl } from '../src/lib/analytics-url';
import { withoutUrlParam } from '../src/lib/sandbox';
import { VercelAnalytics } from '../src/components/VercelAnalytics';
import { HtmlDocument } from '../src/components/HtmlDocument';

(globalThis as { React?: typeof React }).React = React;

// ── 1. beforeSend ──
assert.equal(redactAnalyticsUrl('https://assist.example.com/uk/assistant/try?url=shop.example.ua&utm_source=x#top'), 'https://assist.example.com/uk/assistant/try');
assert.equal(redactAnalyticsUrl('https://assist.example.com/uk/assistant'), 'https://assist.example.com/uk/assistant');
assert.equal(redactAnalyticsUrl('не адрес'), null);
assert.equal(redactAnalyticsUrl('javascript:alert(1)'), null);
assert.deepEqual(analyticsBeforeSend({ type: 'pageview', url: 'https://a.example.com/uk/assistant/try?url=my-shop.ua' }), {
  type: 'pageview',
  url: 'https://a.example.com/uk/assistant/try',
});
assert.equal(analyticsBeforeSend({ type: 'event', url: '%%%' }), null);

// ── 2. Обёртка и её место в документе ──
const wrapper = VercelAnalytics() as React.ReactElement<{ beforeSend?: unknown }>;
assert.equal(wrapper.props.beforeSend, analyticsBeforeSend, 'Analytics без beforeSend — адрес уйдёт с query');

function findTypes(node: React.ReactNode, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) node.forEach((n) => findTypes(n, out));
  else if (React.isValidElement(node)) {
    out.push(node.type);
    findTypes((node.props as { children?: React.ReactNode }).children, out);
  }
  return out;
}
// Как в сборке на Vercel: там адреса продукта — только https (стенд с localhost не годится).
const ENV_KEYS = ['VERCEL', 'ASSIST_WIDGET_ORIGIN', 'ASSIST_API_ORIGIN', 'ASSIST_WIDGET_PK'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
Object.assign(process.env, { VERCEL: '1', ASSIST_WIDGET_ORIGIN: 'https://w.example.com', ASSIST_API_ORIGIN: 'https://api.example.com', ASSIST_WIDGET_PK: 'pk_live_landingstand01' });
const types = findTypes(HtmlDocument({ lang: 'uk', children: null }));
for (const k of ENV_KEYS) {
  if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
}
assert.ok(types.includes(VercelAnalytics), 'на Vercel документ должен рисовать VercelAnalytics');
const htmlDocSrc = readFileSync(path.join(__dirname, '../src/components/HtmlDocument.tsx'), 'utf8');
assert.ok(!/@vercel\/analytics/.test(htmlDocSrc), 'HtmlDocument подключает @vercel/analytics напрямую, мимо beforeSend');

// ── 3. Параметр `url` снимается из адреса страницы ──
assert.equal(withoutUrlParam('https://a.example.com/uk/assistant/try?url=shop.example.ua'), '/uk/assistant/try');
assert.equal(withoutUrlParam('https://a.example.com/uk/assistant/try?utm_source=x&url=shop.ua#f'), '/uk/assistant/try?utm_source=x#f');
assert.equal(withoutUrlParam('https://a.example.com/uk/assistant/try'), null);
assert.equal(withoutUrlParam('https://a.example.com/uk/assistant/try?utm_source=x'), null);
const trySrc = readFileSync(path.join(__dirname, '../src/components/SandboxTry.tsx'), 'utf8');
assert.ok(/replaceState\([^)]*withoutUrlParam|withoutUrlParam\(window\.location\.href\)[\s\S]{0,200}replaceState/.test(trySrc), 'песочница не снимает ?url= из адреса');

console.log('analytics-privacy: ok');
