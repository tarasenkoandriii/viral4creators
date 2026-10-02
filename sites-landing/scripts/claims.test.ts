/**
 * Реестр утверждений (§3.0, урок Б-4) на отрендеренных страницах:
 *
 *  1. На каждой странице × локали: ни одного `hidden` в разметке; каждое
 *     `soon` — с меткой «скоро» и без ссылок/кнопок отправки внутри;
 *     статус в разметке совпадает с реестром.
 *  2. Точка С2 (Л2–Л3): `live` — С0 (бренд, форма пилота, правда о самом
 *     лендинге) и РОВНО список С2 плана §5; всё остальное — не `live`.
 *  3. hero выводится из реестра: сейчас — вариант «answers» (С2); при
 *     переводе этапов в `live` — `preE6` → `full`.
 *  7. Живой виджет (блок 2) — только при `live-widget: live` И ключе
 *     виджета в сборке; без ключа — место под запись. Конфигуратор `hidden`
 *     убирает и страницу (404), и пункт меню, и ссылки на неё.
 *  4. Перевод утверждения в `hidden` действительно убирает его со страниц
 *     (и из FAQ), а в `live` — снимает метку.
 *  5. Блоков `hidden`-фич (песочница, «Подключить в Telegram», «Войти»,
 *     кейсы, документация, блог) нет в разметке ни в каком виде; ссылки
 *     в Telegram (`t.me`, `startapp=`) в статическом HTML нет нигде —
 *     deeplink `wd_` появляется только после сохранения черновика.
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
import WidgetPage from '../src/app/[locale]/assistant/widget/page';
import { liveWidgetTag } from '../src/lib/live-widget';
import { readAssistEnv } from '../src/lib/assist-env';

(globalThis as { React?: typeof React }).React = React;

type PageFn = (props: { params: { locale: Locale } }) => React.ReactElement;
const PAGES: Record<string, PageFn> = {
  home: HomePage,
  assistant: AssistantPage,
  'how-it-works': HowItWorksPage,
  widget: WidgetPage,
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
    for (const bad of ['/assistant/try', '/assistant/cases', '/docs/', '/blog', 't.me/', 'startapp=']) {
      if (html.includes(bad)) problems.push(`${key}/${locale}: след скрытой фичи «${bad}»`);
    }
  }
}
assert.deepEqual(problems, [], problems.join('\n'));
assert.equal(rendered, 24);
assert.ok(soonBlocks > 100, `soon-блоков подозрительно мало: ${soonBlocks}`);

// ── 2. Точка С2 ──
const C0 = ['brand', 'landing-no-trackers', 'pilot-form'];
const C2 = ['site-answers', 'source-links', 'honest-unknown', 'leads', 'branding', 'corners', 'custom-button', 'inline-embed', 'cross-page-state', 'live-widget', 'configurator'];
const live = (Object.keys(CLAIMS) as ClaimId[]).filter((id) => CLAIMS[id].status === 'live').sort();
assert.deepEqual(live, [...C0, ...C2].sort(), `С2: live — ровно С0 + список С2 плана §5; сейчас: ${live}`);
for (const id of ['sandbox', 'tma-connect', 'web-login', 'cases', 'docs', 'blog', 'shopify-app', 'order-status'] as ClaimId[]) {
  assert.equal(CLAIMS[id].status, 'hidden', `${id} должен быть hidden в С2`);
}
// Не названное в С2 — не live, даже если сделано в Э2 (решение владельца).
for (const id of ['telegram-handoff', 'voice', 'video', 'highlight', 'admin-read', 'admin-actions', 'payment', 'install-snippet', 'ownership-verification', 'ai-label', 'widget-fonts'] as ClaimId[]) {
  assert.equal(CLAIMS[id].status, 'soon', `${id} не должен быть live в С2`);
}

// ── 3. Варианты hero ──
assert.equal(heroVariant(), 'answers', 'С2: hero «отвечает по знаниям сайта со ссылкой, заявки — в Telegram»');
const withLive = (...ids: ClaimId[]): ClaimRegistry => {
  const copy = JSON.parse(JSON.stringify(CLAIMS)) as ClaimRegistry;
  // Отсчёт — от С0: всё, от чего зависит hero, сначала «скоро».
  for (const id of ['site-answers', 'leads', 'telegram-handoff', 'voice', 'video', 'highlight'] as ClaimId[]) copy[id].status = 'soon';
  for (const id of ids) copy[id].status = 'live';
  return copy;
};
assert.equal(heroVariant(withLive()), 'pilot');
assert.equal(heroVariant(withLive('site-answers')), 'pilot', 'без лидов hero не меняется');
assert.equal(heroVariant(withLive('site-answers', 'leads')), 'answers');
assert.equal(heroVariant(withLive('site-answers', 'leads', 'telegram-handoff')), 'preE6');
assert.equal(heroVariant(withLive('site-answers', 'leads', 'telegram-handoff', 'voice', 'video')), 'preE6', 'без подсветки — не full');
assert.equal(heroVariant(withLive('site-answers', 'leads', 'telegram-handoff', 'voice', 'video', 'highlight')), 'full');
for (const locale of locales) {
  const html = render(AssistantPage, locale);
  assert.match(html, /data-hero-variant="answers"/);
  assert.ok(html.includes(getDictionary(locale).assistant.hero.answers.title.replace(/'/g, '&#x27;')), `hero answers ${locale}`);
  // «живой диалог в Telegram» (preE6) — только с telegram-handoff (Э3).
  assert.ok(!html.includes(getDictionary(locale).assistant.hero.preE6.lead.replace(/'/g, '&#x27;')), `hero preE6 просочился ${locale}`);
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

// ── 7. Живой виджет и конфигуратор ──
{
  const env = (extra: Record<string, string>) => readAssistEnv({ ...extra });
  assert.equal(liveWidgetTag('uk', env({})), null, 'без ключа виджета живого виджета нет');
  const tag = liveWidgetTag('uk', env({ ASSIST_WIDGET_PK: 'pk_live_landing12345' }));
  assert.deepEqual(tag, { src: 'https://assist-w.viral4creators.app/v1/loader.js', pk: 'pk_live_landing12345', lang: 'uk' });
  const hiddenLive = JSON.parse(JSON.stringify(CLAIMS)) as ClaimRegistry;
  hiddenLive['live-widget'].status = 'soon';
  assert.equal(liveWidgetTag('uk', env({ ASSIST_WIDGET_PK: 'pk_live_landing12345' }), hiddenLive), null, 'live-widget не live — виджета нет');

  const withEnv = <T,>(vars: Record<string, string | undefined>, fn: () => T): T => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  for (const locale of locales) {
    const a = getDictionary(locale).assistant;
    const without = withEnv({ ASSIST_WIDGET_PK: undefined }, () => render(AssistantPage, locale));
    assert.ok(without.includes('data-claim="demo-recording"') && !without.includes('data-testid="playground"'), `без ключа — запись, без панели (${locale})`);
    const withKey = withEnv({ ASSIST_WIDGET_PK: 'pk_live_landing12345' }, () => render(AssistantPage, locale));
    assert.ok(withKey.includes('data-claim="live-widget"') && withKey.includes('data-testid="playground"'), `с ключом — живой блок и панель (${locale})`);
    assert.ok(!withKey.includes('data-claim="demo-recording"'), `с ключом место под запись не нужно (${locale})`);
    assert.ok(withKey.includes(a.live.playground.open), `кнопка «Открыть помощника» (${locale})`);
    assert.deepEqual(claimViolations(withKey, registry, getDictionary(locale).common.soon, `assistant+widget/${locale}`), []);
    // Конфигуратор: сохранение — только с ботом из env (§7.1, без дефолта).
    const c = getDictionary(locale).widgetPage.configurator;
    const noBot = withEnv({ ASSIST_BOT_USERNAME: undefined }, () => render(WidgetPage, locale));
    assert.ok(noBot.includes('data-testid="cfg-stage"') && !noBot.includes(`>${c.save}<`), `без бота нет «Сохранить и подключить» (${locale})`);
    const bot = withEnv({ ASSIST_BOT_USERNAME: 'assist_test_bot' }, () => render(WidgetPage, locale));
    assert.ok(bot.includes(`>${c.save}<`), `с ботом есть «Сохранить и подключить» (${locale})`);
    assert.ok(!bot.includes('t.me/') && !bot.includes('startapp='), `до сохранения deeplink в HTML нет (${locale})`);
  }
  // configurator=hidden: страницы нет, пункта меню и ссылок на неё — тоже.
  const m = CLAIMS as unknown as Record<string, { status: string }>;
  const was = m['configurator'].status;
  try {
    m['configurator'].status = 'hidden';
    for (const locale of locales) {
      assert.throws(() => render(WidgetPage, locale), /NEXT_NOT_FOUND/, `configurator=hidden, а /widget рендерится (${locale})`);
      for (const [key, fn] of Object.entries(PAGES)) {
        if (key === 'widget') continue;
        const html = withEnv({ ASSIST_WIDGET_PK: 'pk_live_landing12345' }, () => render(fn, locale));
        assert.ok(!html.includes('/assistant/widget'), `configurator=hidden, а ссылка на /widget есть: ${key}/${locale}`);
      }
    }
  } finally {
    m['configurator'].status = was;
  }
}

console.log(`ok   реестр утверждений: ${rendered} страниц × локалей, ${soonBlocks} soon-блоков с меткой и без ссылок, hidden нет; live — ровно С0 + С2; hero — «answers»; живой виджет только с ключом; конфигуратор: сохранение только с ботом, hidden убирает страницу и ссылки; переключение статусов работает`);
