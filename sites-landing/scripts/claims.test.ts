/**
 * Реестр утверждений (§3.0, урок Б-4) на отрендеренных страницах:
 *
 *  1. На каждой странице × локали: ни одного `hidden` в разметке; каждое
 *     `soon` — с меткой «скоро» и без ссылок/кнопок отправки внутри;
 *     статус в разметке совпадает с реестром.
 *  2. Точка С0 (Л1): `live` — только бренд, форма пилота и правда о самом
 *     лендинге; всё остальное — не `live`.
 *  3. hero выводится из реестра: сейчас — вариант «пилот»; при переводе
 *     этапов в `live` — `answers` → `preE6` → `full`.
 *  4. Перевод утверждения в `hidden` действительно убирает его со страниц
 *     (и из FAQ), а в `live` — снимает метку.
 *  5. Блоков `hidden`-фич (песочница, «Подключить в Telegram», «Войти»,
 *     кейсы, документация, блог) нет в разметке ни в каком виде.
 */
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CLAIMS, heroVariant, type ClaimDef, type ClaimId, type ClaimRegistry } from '../src/lib/claims';
import { getDictionary } from '../src/lib/get-dictionary';
import { locales, type Locale } from '../src/lib/i18n';
import { claimViolations } from './lib/html';
import { ClaimCard, ClaimSection } from '../src/components/Claim';
import HomePage from '../src/app/[locale]/page';
import AssistantPage from '../src/app/[locale]/assistant/page';
import HowItWorksPage from '../src/app/[locale]/assistant/how-it-works/page';
import SecurityPage from '../src/app/[locale]/assistant/security/page';
import PricingPage from '../src/app/[locale]/assistant/pricing/page';
import FaqPage from '../src/app/[locale]/assistant/faq/page';
import PilotPage from '../src/app/[locale]/assistant/pilot/page';

(globalThis as { React?: typeof React }).React = React;

type PageFn = (props: { params: { locale: Locale } }) => React.ReactElement;
const PAGES: Record<string, PageFn> = {
  home: HomePage,
  assistant: AssistantPage,
  'how-it-works': HowItWorksPage,
  security: SecurityPage,
  pricing: PricingPage,
  faq: FaqPage,
  pilot: PilotPage,
};

const render = (fn: PageFn, locale: Locale) => renderToStaticMarkup(fn({ params: { locale } }));
const registry = CLAIMS as unknown as Record<ClaimId, ClaimDef>;

// ── 1. Все страницы × локали ──
let rendered = 0;
let soonBlocks = 0;
const problems: string[] = [];
for (const locale of locales) {
  const soon = getDictionary(locale).common.soon;
  for (const [key, fn] of Object.entries(PAGES)) {
    const html = render(fn, locale);
    rendered++;
    soonBlocks += (html.match(/data-claim-status="soon"/g) ?? []).length;
    problems.push(...claimViolations(html, registry, soon, `${key}/${locale}`));
    // 5. Следов hidden-фич нет и без data-claim: ни ссылок на /try, /widget,
    // /cases, /docs, /blog, ни t.me-ссылок.
    for (const bad of ['/assistant/try', '/assistant/widget', '/assistant/cases', '/docs/', '/blog', 't.me/', 'startapp=']) {
      if (html.includes(bad)) problems.push(`${key}/${locale}: след скрытой фичи «${bad}»`);
    }
  }
}
assert.deepEqual(problems, [], problems.join('\n'));
assert.equal(rendered, 21);
assert.ok(soonBlocks > 100, `soon-блоков подозрительно мало: ${soonBlocks}`);

// ── 2. Точка С0 ──
const live = (Object.keys(CLAIMS) as ClaimId[]).filter((id) => CLAIMS[id].status === 'live').sort();
assert.deepEqual(live, ['brand', 'landing-no-trackers', 'pilot-form'], `С0: live только бренд, форма пилота и правда о лендинге; сейчас: ${live}`);
for (const id of ['sandbox', 'tma-connect', 'web-login', 'live-widget', 'configurator', 'cases', 'docs', 'blog'] as ClaimId[]) {
  assert.equal(CLAIMS[id].status, 'hidden', `${id} должен быть hidden в Л1`);
}

// ── 3. Варианты hero ──
assert.equal(heroVariant(), 'pilot');
const withLive = (...ids: ClaimId[]): ClaimRegistry => {
  const copy = JSON.parse(JSON.stringify(CLAIMS)) as ClaimRegistry;
  for (const id of ids) copy[id].status = 'live';
  return copy;
};
assert.equal(heroVariant(withLive('site-answers')), 'pilot', 'без лидов hero не меняется');
assert.equal(heroVariant(withLive('site-answers', 'leads')), 'answers');
assert.equal(heroVariant(withLive('site-answers', 'leads', 'telegram-handoff')), 'preE6');
assert.equal(heroVariant(withLive('site-answers', 'leads', 'telegram-handoff', 'voice', 'video')), 'preE6', 'без подсветки — не full');
assert.equal(heroVariant(withLive('site-answers', 'leads', 'telegram-handoff', 'voice', 'video', 'highlight')), 'full');
for (const locale of locales) {
  const html = render(AssistantPage, locale);
  assert.match(html, /data-hero-variant="pilot"/);
  assert.ok(html.includes(getDictionary(locale).assistant.hero.pilot.title.replace(/'/g, '&#x27;')), `hero pilot ${locale}`);
  // Полная формула («показывает, голосом») в HTML не попадает.
  assert.ok(!html.includes(getDictionary(locale).assistant.hero.full.title.replace(/'/g, '&#x27;')), `hero full просочился ${locale}`);
}

// ── 4. Переключение статуса одной строкой ──
const mutable = CLAIMS as unknown as Record<string, { status: string }>;
const saved = mutable['voice'].status;
try {
  mutable['voice'].status = 'hidden';
  for (const locale of locales) {
    for (const key of ['faq', 'pricing', 'assistant'] as const) {
      const html = render(PAGES[key], locale);
      assert.ok(!html.includes('data-claim="voice"'), `voice=hidden, но есть на ${key}/${locale}`);
    }
  }
  mutable['voice'].status = 'live';
  const html = render(PricingPage, 'uk');
  const row = /<tr[^>]*data-claim="voice"[^>]*>[\s\S]*?<\/tr>/.exec(html)?.[0] ?? '';
  assert.ok(row && !row.includes('badge-soon'), 'voice=live — метка «скоро» не снята');
} finally {
  mutable['voice'].status = saved;
}

// ── 6. Сам компонент — второй замок, даже если страница забыла фильтр ──
{
  const dict = getDictionary('uk');
  const card = (claim: string) =>
    renderToStaticMarkup(
      React.createElement(ClaimCard, { claim, dict, title: 'T', text: 'X', cta: { href: '/uk/assistant/pilot', label: 'Go' } }),
    );
  assert.equal(card('sandbox'), '', 'ClaimCard рендерит hidden');
  assert.equal(
    renderToStaticMarkup(React.createElement(ClaimSection, { claim: 'sandbox', dict, heading: 'H', headingId: 'h', children: 'x' })),
    '',
    'ClaimSection рендерит hidden',
  );
  const soon = card('voice');
  assert.ok(soon.includes('badge-soon') && !/<a\s/.test(soon), `soon с CTA: ${soon}`);
  const live = card('pilot-form');
  assert.ok(live.includes('href="/uk/assistant/pilot"') && !live.includes('badge-soon'), 'live без CTA или с меткой');
  assert.throws(() => card('no-such-claim'), /Неизвестное утверждение/);
}

console.log(`ok   реестр утверждений: ${rendered} страниц × локалей, ${soonBlocks} soon-блоков с меткой и без ссылок, hidden нет; hero — «пилот»; переключение статусов работает`);
