/**
 * Реестр утверждений (§3.0, урок Б-4) на отрендеренных страницах:
 *
 *  1. На каждой странице × локали: ни одного `hidden` в разметке; каждое
 *     `soon` — с меткой «скоро» и без ссылок/кнопок отправки внутри;
 *     статус в разметке совпадает с реестром.
 *  2. Точки С1 и С3 (Л4–Л5): `live` — С0, С2 и РОВНО то, что добавляют С1
 *     (песочница, страница бота с opt-out) и С3 (живой человек в Telegram,
 *     отчёт недели, статистика целей и вебхук, страницы платформ — код,
 *     инструкции, подтверждение, JS API, документация); плагин WordPress и
 *     npm — `soon` (не опубликованы), сравнение — `hidden` (нет сверки).
 *  3. hero выводится из реестра: сейчас — вариант «preE6» (С3); при
 *     переводе голоса/видео/подсветки в `live` — `full`.
 *  7. Живой виджет (блок 2) — только при `live-widget: live` И ключе
 *     виджета в сборке; без ключа — место под запись. Конфигуратор `hidden`
 *     убирает и страницу (404), и пункт меню, и ссылки на неё.
 *  4. Перевод утверждения в `hidden` действительно убирает его со страниц
 *     (и из FAQ), а в `live` — снимает метку.
 *  5. Блоков `hidden`-фич («Подключить в Telegram», «Войти», кейсы,
 *     сравнение, блог) нет в разметке ни в каком виде; ссылки в Telegram
 *     (`t.me`, `startapp=`) в статическом HTML нет нигде — deeplink `wd_`/`sb_`
 *     появляется только после сохранения черновика / готовой песочницы.
 *  8. Л4–Л5: `sandbox=hidden` убирает `/try`, поле адреса в hero и все ссылки
 *     на песочницу; `docs=hidden` — документацию и пункт меню; страницы
 *     платформ — только для видимых утверждений; документация — uk/en (ru —
 *     404, а ссылки из ru ведут на uk с `hrefLang`).
 */
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CLAIMS, heroVariant, type ClaimDef, type ClaimId, type ClaimRegistry } from '../src/lib/claims';
import { getDictionary } from '../src/lib/get-dictionary';
import { locales, type Locale } from '../src/lib/i18n';
import { claimViolations } from './lib/html';
import { NOT_FOUND, renderPage, type AsyncPage } from './lib/page';
import { ClaimCard, ClaimSection } from '../src/components/Claim';
import HomePage from '../src/app/[locale]/page';
import AssistantPage from '../src/app/[locale]/assistant/page';
import HowItWorksPage from '../src/app/[locale]/assistant/how-it-works/page';
import SecurityPage from '../src/app/[locale]/assistant/security/page';
import PricingPage from '../src/app/[locale]/assistant/pricing/page';
import FaqPage from '../src/app/[locale]/assistant/faq/page';
import PilotPage from '../src/app/[locale]/assistant/pilot/page';
import WidgetPage from '../src/app/[locale]/assistant/widget/page';
import TryPage from '../src/app/[locale]/assistant/try/page';
import BotPage from '../src/app/[locale]/assistant/bot/page';
import IntegrationsPage from '../src/app/[locale]/assistant/integrations/page';
import PlatformPage from '../src/app/[locale]/assistant/integrations/[platform]/page';
import DocsInstallPage from '../src/app/[locale]/docs/assistant/page';
import DocsSubPage from '../src/app/[locale]/docs/assistant/[doc]/page';
import { PLATFORMS } from '../src/lib/platforms';
import { DOCS_LOCALES } from '../src/lib/pages';
import { liveWidgetTag } from '../src/lib/live-widget';
import { readAssistEnv } from '../src/lib/assist-env';

(globalThis as { React?: typeof React }).React = React;

type PageFn = AsyncPage<{ locale: Locale }>;
const PAGES: Record<string, PageFn> = {
  home: HomePage,
  assistant: AssistantPage,
  'how-it-works': HowItWorksPage,
  widget: WidgetPage,
  try: TryPage,
  bot: BotPage,
  integrations: IntegrationsPage,
  ...Object.fromEntries(
    PLATFORMS.map((p) => [`integrations-${p.slug}`, (async ({ params }) => PlatformPage({ params: params.then((v) => ({ ...v, platform: p.slug })) })) as PageFn]),
  ),
  security: SecurityPage,
  pricing: PricingPage,
  faq: FaqPage,
  pilot: PilotPage,
};
/** Документация — только uk/en. */
const DOC_PAGES: Record<string, PageFn> = {
  docs: DocsInstallPage,
  ...Object.fromEntries(
    ['js-api', 'goals', 'csp'].map((d) => [`docs-${d}`, (async ({ params }) => DocsSubPage({ params: params.then((v) => ({ ...v, doc: d })) })) as PageFn]),
  ),
};

const render = (fn: PageFn, locale: Locale) => renderPage(fn, { locale });
const registry = CLAIMS as unknown as Record<ClaimId, ClaimDef>;

// Страницы Next 15 асинхронные (`params` — Promise) — проверки в async main.
async function main() {
  // ── 1. Все страницы × локали ──
  let rendered = 0;
  let soonBlocks = 0;
  const problems: string[] = [];
  for (const locale of locales) {
    const soon = getDictionary(locale).common.soon;
    const pages = { ...PAGES, ...((DOCS_LOCALES as readonly Locale[]).includes(locale) ? DOC_PAGES : {}) };
    for (const [key, fn] of Object.entries(pages)) {
      const html = await render(fn, locale);
      rendered++;
      soonBlocks += (html.match(/data-claim-status="soon"/g) ?? []).length;
      problems.push(...claimViolations(html, registry, soon, `${key}/${locale}`));
      // 5. Следов hidden-фич нет и без data-claim: ни ссылок на /cases,
      // /compare, /blog, ни t.me-ссылок.
      if (/\{[a-zA-Z]+\}|%%[A-Za-z]+%%/.test(html.replace(/<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>/g, ''))) problems.push(`${key}/${locale}: неподставленный плейсхолдер`);
      for (const bad of ['/assistant/cases', '/assistant/compare', '/blog', 't.me/', 'startapp=']) {
        if (html.includes(bad)) problems.push(`${key}/${locale}: след скрытой фичи «${bad}»`);
      }
    }
    // Документация не во всех локалях: ru — 404.
    if (!(DOCS_LOCALES as readonly Locale[]).includes(locale)) {
      for (const [key, fn] of Object.entries(DOC_PAGES)) await assert.rejects(render(fn, locale), NOT_FOUND, `${key}/${locale} должна быть 404`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
  const expectedRendered = Object.keys(PAGES).length * locales.length + Object.keys(DOC_PAGES).length * DOCS_LOCALES.length;
  assert.equal(rendered, expectedRendered);
  assert.ok(soonBlocks > 100, `soon-блоков подозрительно мало: ${soonBlocks}`);

  // ── 2. Точки С1 и С3 ──
  const C0 = ['brand', 'landing-no-trackers', 'pilot-form'];
  const C2 = ['site-answers', 'source-links', 'honest-unknown', 'leads', 'branding', 'corners', 'custom-button', 'inline-embed', 'cross-page-state', 'live-widget', 'configurator'];
  /** С1: песочница `live` только после IP-pin, мета-теста SSRF и денежного потолка (всё — Э1). */
  const C1 = ['sandbox', 'crawler-opt-out'];
  /** С3 (план §5): живой человек, отчёт недели, статистика целей, страницы платформ (Л5). */
  const C3 = ['telegram-handoff', 'weekly-report', 'goal-stats', 'goal-webhook', 'integrations', 'install-snippet', 'install-guides', 'ownership-verification', 'js-api', 'docs'];
  const live = (Object.keys(CLAIMS) as ClaimId[]).filter((id) => CLAIMS[id].status === 'live').sort();
  assert.deepEqual(live, [...C0, ...C2, ...C1, ...C3].sort(), `С1+С3: live — ровно С0 + С2 + С1 + С3; сейчас: ${live}`);
  for (const id of ['tma-connect', 'web-login', 'cases', 'compare', 'blog', 'shopify-app', 'order-status'] as ClaimId[]) {
    assert.equal(CLAIMS[id].status, 'hidden', `${id} должен быть hidden`);
  }
  // Плагин и npm в коде есть, но не опубликованы — «скоро»; скриншот — только на воркере QA.
  for (const id of ['wp-plugin', 'npm-package', 'sandbox-screenshot', 'more-platforms', 'voice', 'video', 'highlight', 'admin-read', 'admin-actions', 'payment', 'ai-label', 'widget-fonts'] as ClaimId[]) {
    assert.equal(CLAIMS[id].status, 'soon', `${id} не должен быть live`);
  }

  // ── 3. Варианты hero ──
  assert.equal(heroVariant(), 'preE6', 'С3: hero «…заявки и живой диалог — в вашем Telegram»');
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
    const html = await render(AssistantPage, locale);
    assert.match(html, /data-hero-variant="preE6"/);
    assert.ok(html.includes(getDictionary(locale).assistant.hero.preE6.lead.replace(/'/g, '&#x27;')), `hero preE6 ${locale}`);
    // Поле адреса в hero → песочница (GET-форма без JS), и ещё раз в конце страницы.
    // Порядок атрибутов не проверяем: React 19 пишет `action` формы последним.
    const tryForms = (html.match(/<form class="try-form"[^>]*>/g) ?? []).filter((f) => f.includes('method="get"') && /action="\/[a-z]{2}\/assistant\/try"/.test(f));
    assert.equal(tryForms.length, 2, `поле адреса в hero и финале (${locale})`);
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
        const html = await render(PAGES[key], locale);
        assert.ok(!html.includes('data-claim="voice"'), `voice=hidden, но есть на ${key}/${locale}`);
      }
    }
    mutable['voice'].status = 'live';
    const html = await render(PricingPage, 'uk');
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
    assert.equal(card('cases'), '', 'ClaimCard рендерит hidden');
    assert.equal(
      renderToStaticMarkup(React.createElement(ClaimSection, { claim: 'cases', dict, heading: 'H', headingId: 'h', children: 'x' })),
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

    const withEnv = async <T,>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
      const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
      Object.assign(process.env, vars);
      for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
      try {
        return await fn();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    };
    for (const locale of locales) {
      const a = getDictionary(locale).assistant;
      const without = await withEnv({ ASSIST_WIDGET_PK: undefined }, () => render(AssistantPage, locale));
      assert.ok(without.includes('data-claim="demo-recording"') && !without.includes('data-testid="playground"'), `без ключа — запись, без панели (${locale})`);
      const withKey = await withEnv({ ASSIST_WIDGET_PK: 'pk_live_landing12345' }, () => render(AssistantPage, locale));
      assert.ok(withKey.includes('data-claim="live-widget"') && withKey.includes('data-testid="playground"'), `с ключом — живой блок и панель (${locale})`);
      assert.ok(!withKey.includes('data-claim="demo-recording"'), `с ключом место под запись не нужно (${locale})`);
      assert.ok(withKey.includes(a.live.playground.open), `кнопка «Открыть помощника» (${locale})`);
      assert.deepEqual(claimViolations(withKey, registry, getDictionary(locale).common.soon, `assistant+widget/${locale}`), []);
      // Конфигуратор: сохранение — только с ботом из env (§7.1, без дефолта).
      const c = getDictionary(locale).widgetPage.configurator;
      const noBot = await withEnv({ ASSIST_BOT_USERNAME: undefined }, () => render(WidgetPage, locale));
      assert.ok(noBot.includes('data-testid="cfg-stage"') && !noBot.includes(`>${c.save}<`), `без бота нет «Сохранить и подключить» (${locale})`);
      const bot = await withEnv({ ASSIST_BOT_USERNAME: 'assist_test_bot' }, () => render(WidgetPage, locale));
      assert.ok(bot.includes(`>${c.save}<`), `с ботом есть «Сохранить и подключить» (${locale})`);
      assert.ok(!bot.includes('t.me/') && !bot.includes('startapp='), `до сохранения deeplink в HTML нет (${locale})`);
    }
    // configurator=hidden: страницы нет, пункта меню и ссылок на неё — тоже.
    const m = CLAIMS as unknown as Record<string, { status: string }>;
    const was = m['configurator'].status;
    try {
      m['configurator'].status = 'hidden';
      for (const locale of locales) {
        await assert.rejects(render(WidgetPage, locale), NOT_FOUND, `configurator=hidden, а /widget рендерится (${locale})`);
        for (const [key, fn] of Object.entries(PAGES)) {
          if (key === 'widget') continue;
          const html = await withEnv({ ASSIST_WIDGET_PK: 'pk_live_landing12345' }, () => render(fn, locale));
          assert.ok(!html.includes('/assistant/widget'), `configurator=hidden, а ссылка на /widget есть: ${key}/${locale}`);
        }
      }
    } finally {
      m['configurator'].status = was;
    }
  }

  // ── 8. Л4–Л5: песочница, документация, платформы ──
  {
    const m = CLAIMS as unknown as Record<string, { status: string }>;
    const flip = async <T,>(id: string, status: string, fn: () => Promise<T>): Promise<T> => {
      const was = m[id].status;
      m[id].status = status;
      try {
        return await fn();
      } finally {
        m[id].status = was;
      }
    };
    await flip('sandbox', 'hidden', async () => {
      for (const locale of locales) {
        await assert.rejects(render(TryPage, locale), NOT_FOUND, `sandbox=hidden, а /try рендерится (${locale})`);
        for (const [key, fn] of Object.entries(PAGES)) {
          if (key === 'try') continue;
          const html = await render(fn, locale);
          assert.ok(!html.includes('/assistant/try') && !html.includes('try-form'), `sandbox=hidden, а ссылка/поле песочницы есть: ${key}/${locale}`);
        }
      }
    });
    await flip('docs', 'hidden', async () => {
      for (const locale of DOCS_LOCALES) await assert.rejects(render(DOC_PAGES.docs, locale), NOT_FOUND);
      for (const locale of locales) for (const key of ['assistant', 'integrations', 'integrations-react']) assert.ok(!(await render(PAGES[key], locale)).includes('/docs/assistant'), `docs=hidden, а ссылка на документацию есть: ${key}/${locale}`);
    });
    await flip('integrations', 'hidden', async () => {
      await assert.rejects(render(IntegrationsPage, 'uk'), NOT_FOUND);
      assert.ok(!(await render(AssistantPage, 'uk')).includes('/assistant/integrations'));
    });
    // Из ru документация — на uk с hrefLang.
    const ru = await render(AssistantPage, 'ru');
    assert.match(ru, /href="\/uk\/docs\/assistant" hrefLang="uk"/, 'ru → документация uk с hrefLang');
    // Песочница: до запуска — форма без deeplink; лимиты — из модели (8/10/24/3).
    for (const locale of locales) {
      const html = await render(TryPage, locale);
      assert.ok(html.includes('id="sb-url"') && html.includes('data-claim="sandbox-screenshot"'), `/try: форма и «скриншот — скоро» (${locale})`);
      assert.ok(!html.includes('startapp='), `/try: deeplink до песочницы (${locale})`);
    }
    // Страница платформы: плагин/npm — «скоро» без кода; код вставки — с заглушкой ключа.
    const wp = await render(PAGES['integrations-wordpress'], 'uk');
    const wpSoon = /<div[^>]*data-claim="wp-plugin"[\s\S]*?<\/div>/.exec(wp)?.[0] ?? '';
    assert.ok(wpSoon.includes('badge-soon') && !wpSoon.includes('<pre'), 'плагин WordPress: «скоро» без кода');
    assert.ok(wp.includes('add_action(&#x27;wp_head&#x27;'), 'код для WordPress');
  }

  console.log(`ok   реестр утверждений: ${rendered} страниц × локалей, ${soonBlocks} soon-блоков с меткой и без ссылок, hidden нет; live — ровно С0 + С2 + С1 + С3; hero — «preE6» с полем адреса; живой виджет только с ключом; конфигуратор, песочница, документация и интеграции — hidden убирает страницы и ссылки; переключение статусов работает`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
