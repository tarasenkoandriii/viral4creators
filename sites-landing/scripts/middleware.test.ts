/**
 * Middleware локалей (§11): корень и пути без локали → 307 на локаль
 * (cookie выбора → Accept-Language → en); ссылка переключателя `?hl=`
 * пишет cookie и уводит на чистый адрес; локализованные пути не трогаются;
 * служебные (`/api`, `/legal`, файлы) под matcher не попадают.
 */
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { config, middleware } from '../src/middleware';

const call = (url: string, headers: Record<string, string> = {}) => middleware(new NextRequest(new URL(url, 'https://site.example'), { headers }));

{
  const r = call('/');
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), 'https://site.example/en');
  assert.equal(r.cookies.get('NEXT_LOCALE'), undefined, 'без явного выбора cookie не пишется');
}
assert.equal(call('/', { 'accept-language': 'uk-UA,uk;q=0.9' }).headers.get('location'), 'https://site.example/uk');
assert.equal(call('/assistant/pricing?utm_source=x', { 'accept-language': 'ru' }).headers.get('location'), 'https://site.example/ru/assistant/pricing?utm_source=x');
assert.equal(call('/', { 'accept-language': 'uk', cookie: 'NEXT_LOCALE=ru' }).headers.get('location'), 'https://site.example/ru', 'cookie выбора важнее Accept-Language');
assert.equal(call('/', { cookie: 'NEXT_LOCALE=de' }).headers.get('location'), 'https://site.example/en', 'мусор в cookie игнорируется');
{
  const r = call('/uk/assistant');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('location'), null);
}
{
  const r = call('/ru/assistant/faq?hl=ru');
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), 'https://site.example/ru/assistant/faq');
  assert.equal(r.cookies.get('NEXT_LOCALE')?.value, 'ru');
}
{
  const r = call('/ru/assistant?hl=en');
  assert.equal(r.headers.get('location'), 'https://site.example/ru/assistant');
  assert.equal(r.cookies.get('NEXT_LOCALE'), undefined, 'hl не совпал с локалью пути — cookie не пишем');
}
const matcher = new RegExp(`^${config.matcher[0]}$`);
for (const p of ['/', '/assistant', '/uk/assistant/pricing']) assert.ok(matcher.test(p), `matcher пропустил ${p}`);
for (const p of ['/api/pilot', '/legal/privacy', '/_next/static/x.js', '/og/home-uk.jpg', '/robots.txt', '/sitemap.xml', '/icon.svg']) {
  assert.ok(!matcher.test(p), `matcher зацепил ${p}`);
}
console.log('ok   middleware: корень и пути без локали → 307 (cookie → Accept-Language → en), ?hl= пишет cookie и чистит адрес, служебные пути вне matcher');
