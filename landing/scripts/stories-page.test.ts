/**
 * Story‑Tales: собранная страница пяти локалей в режиме `prep`
 * (`src/app/(stories)/[locale]/stories/page.tsx` внутри настоящего
 * `app/(stories)/[locale]/layout.tsx` — S3-7: без словаря главной).
 *
 * Режимы лендинга (`STORY_TALES_LANDING`, Р-ST3-6) — дочерними
 * процессами: `closed` (по умолчанию — проверки ниже как были), `pilot`
 * («пилот по приглашению, до 15 семей», noindex, блок «что доступно» с
 * откатом и с данными API) и `public` (без noindex и без пункта о
 * закрытой индексации). Форма, поля и `<script>` запрещены во всех.
 *
 * Рендер — тем же приёмом, что `html-lang.test.ts`: async-компоненты
 * вызываются как функции, результат — `renderToStaticMarkup`. Что
 * проверяется:
 *
 *  - `<html lang="<locale>" dir="ltr">` на всех пяти локалях;
 *  - ST-LPL-01/02 (§5.1): нет «Создать сказку», «Посмотреть пример»,
 *    «Узнать о пилоте», нет `<video>`/`<audio>`/`<button>`/Play, нет
 *    формы и полей; основной CTA — «Как это работает» якорем `#how`
 *    (шапка, первый экран, финал);
 *  - подпись «Иллюстрация формата» видимым `<figcaption>`;
 *  - FAQ: десять `<details>`; переключатель языка — ссылки на пять
 *    локалей с `hreflang`;
 *  - Р-STL-17: основной CTA — «Открыть в Telegram» в раздел TMA
 *    `#/stories` (`startapp=e_stories`, ничего больше в адресе), «Как это
 *    работает» — вторым, рядом подпись о профиле рассказчика; сценарий
 *    `fallback` (дочерний процесс: боевая сборка без бота и адреса TMA) —
 *    основным становится якорь `#how`, ссылок в приложение нет;
 *  - Р-STL-15/16: слова «пилот» в HTML нет, блок «Запуск», слоган в
 *    первом экране и финале;
 *  - Р-STL-18: своя OG-карточка — файлы `public/og/stories-<locale>.jpg`
 *    1200×630 в бюджете, отпечаток текстов совпадает с генератором;
 *  - подвал: только существующие `/legal/<slug>`;
 *  - все ссылки — якоря, свои пути, TMA или t.me (внешних хостов нет);
 *  - метаданные: robots `noindex, nofollow, noarchive`, referrer
 *    `no-referrer`, canonical на поддомене, hreflang пяти локалей, без
 *    ключевых слов и картинки главной;
 *  - Р-STL-8: в исходниках страницы нет аналитики, консультанта и
 *    `next/script`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

/**
 * Сценарий задаёт окружение ДО импорта страницы: адрес TMA и имя бота
 * читаются при загрузке `lib/content.ts`. По умолчанию — бот задан
 * (`telegram`); в конце тест запускает себя же дочерним процессом в
 * сценарии `fallback`.
 */
const SCENARIO = process.env.STORIES_PAGE_SCENARIO === 'fallback' ? 'fallback' : 'telegram';
const MODE = (['pilot', 'public'] as const).find((m) => m === process.env.STORY_TALES_LANDING) ?? 'closed';
if (MODE === 'closed') delete process.env.STORY_TALES_LANDING;
/**
 * Ответ `GET /api/public/story-capabilities` в дочернем `pilot`/`public`:
 * `api` — данные (как отдаёт backend, в конверте), `down` — сеть падает.
 */
const CAPS_API = process.env.STORIES_PAGE_CAPS === 'api' ? 'api' : 'down';
const API_TALE = { slug: 'mitten', title: 'Рукавичка', titles: { ru: 'Рукавичка', uk: 'Рукавичка' }, languages: ['ru', 'uk'], formats: ['audio', 'video'] };
const capsRequests: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  capsRequests.push(url);
  if (CAPS_API === 'down' || !url.endsWith('/public/story-capabilities')) throw new Error('offline');
  const data = { mode: MODE, languages: ['ru', 'uk'], tales: [API_TALE, { slug: 'Bad Slug', title: 'x', languages: ['ru'] }], formats: ['audio', 'video', 'hologram'], priceFromUsd: 2.99 };
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;
const BOT = 'v4c_bot';
if (SCENARIO === 'telegram') {
  process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = BOT;
}
const TG_HREF = `https://t.me/${BOT}/app?startapp=e_stories`;

const ROOT = path.join(__dirname, '..');
const PAGE_DIR = path.join(ROOT, 'src', 'app', '(stories)', '[locale]', 'stories');
const LAYOUT_FILE = path.join(ROOT, 'src', 'app', '(stories)', '[locale]', 'layout.tsx');

/** Ширина и высота JPEG из маркера SOF. */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

async function main() {
  const { default: LocaleLayout } = await import('../src/app/(stories)/[locale]/layout');
  const page = await import('../src/app/(stories)/[locale]/stories/page');
  const StoriesLandingPage = page.default;
  const { generateMetadata, viewport } = page;
  const { LOCALE_DIR, locales } = await import('../src/lib/i18n');
  const { LEGAL_DOCS } = await import('../src/lib/legal-content');
  const { STORIES_COPY } = await import('../src/lib/stories/copy');
  const { STORIES_REFERRER_POLICY, STORIES_ROBOTS, STORIES_SITE_URL, storiesPageUrl } = await import(
    '../src/lib/stories-host'
  );
  const { TMA_URL } = await import('../src/lib/content');
  const { OG_CARD_BYTES_MAX, ogCardFingerprint } = await import('../src/lib/stories/og');

  async function render(locale: string): Promise<string> {
    const params = Promise.resolve({ locale });
    const tree = await LocaleLayout({ params, children: await StoriesLandingPage({ params }) });
    return renderToStaticMarkup(tree);
  }

  const legalSlugs = new Set(LEGAL_DOCS.map((d) => d.slug));

  for (const locale of locales) {
    const t = STORIES_COPY[locale];
    const html = await render(locale);
    /** Тексты доступа режима; в `closed` — `null` (тексты `prep`). */
    const A = MODE === 'closed' ? null : t.access[MODE];
    assert.match(html, new RegExp(`data-landing-mode="${MODE}"`), `${locale}: режим лендинга`);

    // ── документ и язык ──
    const open = /^<html\b[^>]*>/.exec(html)?.[0] ?? '';
    assert.match(open, new RegExp(`\\blang="${locale}"`), `${locale}: ${open}`);
    assert.match(open, new RegExp(`\\bdir="${LOCALE_DIR[locale]}"`), `${locale}: ${open}`);
    assert.match(html, /data-release-mode="prep"/, `${locale}: режим не prep`);

    // ── §5.1: ничего, чего нет ──
    for (const re of [/<video\b/, /<audio\b/, /<button\b/, /<form\b/, /<input\b/, /<textarea\b/, /<select\b/, /<iframe\b/, /<script\b/, /<img\b/]) {
      assert.doesNotMatch(html, re, `${locale}: ${re} в режиме prep`);
    }
    assert.doesNotMatch(html, /class="[^"]*\bplay/i, `${locale}: элемент Play`);
    for (const id of ['create', 'example', 'lead'] as const) {
      assert.doesNotMatch(html, new RegExp(`data-cta="${id}"`), `${locale}: CTA ${id} в prep`);
      assert.ok(!html.includes(`>${t.cta[id]}<`), `${locale}: подпись «${t.cta[id]}» в prep`);
    }
    // Якоря «Пример» в шапке без демо нет.
    assert.doesNotMatch(html, /class="st-nav-link" href="#example"/, `${locale}: якорь «Пример» без демо`);

    // ── основной CTA (Р-STL-17) ──
    const entries = [...html.matchAll(/href="([^"]+)" data-cta="(telegram|app)" data-entry="stories"/g)].map((m) => decode(m[1]));
    if (SCENARIO === 'telegram') {
      // «Открыть в Telegram» — шапка, первый экран, финал; «Как это
      // работает» — вторым, только в первом экране.
      assert.equal(count(html, /data-cta="telegram"/g), 3, `${locale}: «Открыть в Telegram» не в шапке/первом экране/финале`);
      assert.deepEqual(entries, [TG_HREF, TG_HREF, TG_HREF], `${locale}: CTA не в раздел #/stories`);
      assert.equal(count(html, />Открыть в Telegram<|>Відкрити в Telegram<|>Open in Telegram<|>In Telegram öffnen<|>Abrir en Telegram</g), 3, `${locale}: подпись CTA`);
      assert.ok(html.includes(`>${t.cta.telegram}</a>`), `${locale}: нет «${t.cta.telegram}»`);
      assert.equal(count(html, /href="#how" data-cta="how"/g), 1, `${locale}: «Как это работает» не вторым`);
      assert.ok(html.includes(`<p class="st-app-note">${A ? A.appNote : t.hero.appNote}</p>`), `${locale}: нет подписи у кнопки в приложение`);
      // Ссылка уже основная — в блоке шагов не дублируется.
      assert.equal(count(html, /data-entry="stories"/g), 3, `${locale}: ссылка в приложение продублирована`);
      // Тексты о приложении — раз путь туда есть (S3-5).
      const finalText = A ? A.finalText : t.final.text;
      const finalNeutral = A ? A.finalTextNeutral : t.final.textNeutral;
      assert.ok(html.includes(finalText) && !html.includes(finalNeutral), `${locale}: финальный текст`);
      for (const item of A ? A.available : t.launch.available) assert.ok(html.includes(item), `${locale}: «${item}»`);
      // Р-STL-19: контакт — Telegram-бот платформы.
      assert.ok(
        html.includes(`<a href="https://t.me/${BOT}" data-contact="telegram">${t.footer.contactBot} @${BOT}</a>`),
        `${locale}: нет контакта-бота в подвале`,
      );
    } else {
      assert.deepEqual(entries, [], `${locale}: ссылка в приложение без бота и адреса TMA`);
      assert.doesNotMatch(html, /data-entry="stories"|t\.me\/|entry=stories/, `${locale}: мёртвая ссылка в приложение`);
      assert.equal(count(html, /href="#how" data-cta="how"/g), 3, `${locale}: откат — основной CTA не «Как это работает»`);
      assert.doesNotMatch(html, /st-app-note/, `${locale}: подпись о приложении без ссылки`);
      // Без пути в приложение — нейтральные тексты (S3-5) и без контакта-бота.
      assert.ok(html.includes(t.final.textNeutral) && !html.includes(t.final.text), `${locale}: финал ссылается на приложение`);
      for (const item of t.launch.available) assert.ok(!html.includes(item), `${locale}: «${item}» без ссылки в приложение`);
      for (const item of t.launch.availableNeutral) assert.ok(html.includes(item), `${locale}: «${item}»`);
      assert.equal(MODE, 'closed', 'сценарий fallback — только в closed');
      assert.doesNotMatch(html, /data-contact=/, `${locale}: контакт без бота`);
    }
    assert.ok(html.includes(`>${t.cta.how}</a>`), `${locale}: нет подписи «${t.cta.how}»`);
    // ── Р-STL-15/16; Р-ST3-6: «пилот» и число семей — только в `pilot` ──
    if (MODE === 'pilot') {
      assert.match(html, /пилот|пілот|pilot|piloto/i, `${locale}: нет «пилота» в режиме pilot`);
      assert.ok(html.includes(`<strong>${t.access.pilot.status}</strong>`), `${locale}: статус пилота`);
      assert.match(t.access.pilot.status, /15/, `${locale}: «до 15 семей»`);
    } else {
      assert.doesNotMatch(html, /пилот|пілот|pilot|piloto/i, `${locale}: «пилот» в HTML (${MODE})`);
    }
    assert.equal(count(html, new RegExp(`<p class="st-tagline">${t.tagline}</p>`, 'g')), 2, `${locale}: слоган не в первом экране и финале`);
    assert.ok(html.includes(t.launch.title) && html.includes(A ? A.note : t.launch.note), `${locale}: нет блока «Запуск»`);
    for (const item of A ? A.coming : t.launch.coming) assert.ok(html.includes(item), `${locale}: «${item}»`);
    if (A) {
      for (const item of t.launch.coming.filter((i) => !A.coming.includes(i) && !A.available.includes(i))) assert.ok(!html.includes(item), `${locale}: текст prep «${item}» в ${MODE}`);
      assert.ok(!html.includes(t.launch.note), `${locale}: «ничего не продаётся» prep в ${MODE}`);
    }
    // Пункт о закрытой индексации — пока она правда закрыта.
    assert.equal(html.includes(t.privacy.noindex), MODE === 'closed', `${locale}: пункт о noindex в ${MODE}`);
    // ST3-U-06/13: семейный голос, голос в FAQ и снятие ссылки — как есть.
    for (const v of Object.values(t.opened)) assert.equal(decode(html).includes(v), MODE !== 'closed', `${locale}: «${v.slice(0, 40)}…» в ${MODE}`);
    if (A) {
      assert.ok(!decode(html).includes(t.narrator.items[2].text), `${locale}: «семейного голоса нет» в ${MODE}`);
      assert.ok(!decode(html).includes(t.faq.items[5].answer) && !decode(html).includes(t.faq.items[1].answer), `${locale}: FAQ будущим временем в ${MODE}`);
      for (const old of [t.faq.items[2].answer, t.faq.items[7].answer, t.narrator.sketch.text, t.how.steps[2]]) {
        assert.ok(!decode(html).includes(old), `${locale}: образ рассказчика обещан в ${MODE}: «${old.slice(0, 40)}…»`);
      }
    }
    // FAQ: в pilot/public свои ответы о языках и цене (вопросы — те же).
    assert.equal(decode(html).includes(t.faq.items[8].answer), MODE === 'closed', `${locale}: ответ о цене prep в ${MODE}`);
    if (A) {
      assert.ok(decode(html).includes(A.faqPrice) && decode(html).includes(A.faqLanguages), `${locale}: ответы FAQ режима ${MODE}`);
    }
    // Блок «что доступно» — только в pilot/public; данные API или откат.
    if (A) {
      assert.ok(html.includes(A.capabilitiesTitle), `${locale}: нет блока «что доступно»`);
      assert.match(html, new RegExp(`data-capabilities="${CAPS_API === 'api' ? 'api' : 'static'}"`), `${locale}: источник блока`);
      assert.ok(html.includes(t.capabilities.languageNames.ru) && html.includes(t.capabilities.languageNames.uk), `${locale}: языки историй`);
      if (CAPS_API === 'api') {
        assert.match(html, /data-tale="mitten"/, `${locale}: история из API`);
        assert.doesNotMatch(html, /Bad Slug|hologram/, `${locale}: негодные поля API не отброшены`);
        assert.ok(html.includes(`${t.capabilities.formatNames.audio}, ${t.capabilities.formatNames.video}`), `${locale}: форматы`);
        assert.match(html, /data-price-from="2.99"/, `${locale}: «цена от»`);
        assert.match(decode(html), /2[.,]99/, `${locale}: сумма`);
        assert.ok(decode(html).includes(t.capabilities.priceFrom.split('{price}')[1]), `${locale}: «за шаг сборки; видео — отдельный шаг»`);
      } else {
        assert.ok(html.includes(t.capabilities.staticLead) && html.includes(t.capabilities.talesEmpty), `${locale}: откат без подписи`);
        assert.doesNotMatch(html, /data-price-from|data-tale=/, `${locale}: цена или истории в откате`);
      }
    } else {
      assert.doesNotMatch(html, /data-capabilities/, `${locale}: блок «что доступно» в closed`);
    }
    for (const id of ['top', 'content', 'example', 'audience', 'how', 'narrator', 'catalog', 'privacy', 'launch', 'faq']) {
      assert.equal(count(html, new RegExp(`id="${id}"`, 'g')), 1, `${locale}: блок #${id}`);
    }
    for (const href of new Set([...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]))) {
      assert.match(html, new RegExp(`id="${href}"`), `${locale}: якорь #${href} в никуда`);
    }

    // ── тексты блоков ──
    assert.ok(html.includes(`<figcaption>${t.hero.illustrationCaption}</figcaption>`), `${locale}: нет подписи иллюстрации`);
    assert.ok(html.includes(A ? A.badge : t.hero.badge), `${locale}: нет бейджа`);
    assert.ok(html.includes(A ? A.howBadge : t.how.plannedBadge), `${locale}: шаги не помечены`);
    assert.ok(html.includes(A ? A.catalogStatus : t.catalog.status), `${locale}: нет статуса каталога`);
    assert.ok(html.includes(A ? A.status : t.launch.status), `${locale}: нет статуса запуска`);
    if (A) assert.ok(!html.includes(`>${t.hero.badge}<`) && !html.includes(t.how.lead), `${locale}: тексты prep в ${MODE}`);
    assert.match(html, /role="img" aria-label="[^"]+"/, `${locale}: у иллюстрации нет описания`);

    // ── FAQ и язык ──
    assert.equal(count(html, /<details\b/g), 11, `${locale}: 10 вопросов + меню языка`);
    for (const item of t.faq.items) assert.ok(html.includes(decode(item.question)) || decode(html).includes(item.question), `${locale}: вопрос «${item.question}»`);
    for (const l of locales) {
      assert.match(html, new RegExp(`href="/${l}" hrefLang="${l}" lang="${l}"`), `${locale}: нет ссылки на ${l}`);
    }
    assert.match(html, new RegExp(`href="/${locale}" hrefLang="${locale}" lang="${locale}" aria-current="true"`), `${locale}: текущий язык не отмечен`);


    // ── подвал ──
    const legal = [...html.matchAll(/href="(?:https?:\/\/[^/"]+)?\/legal\/([^"]+)"/g)].map((m) => m[1]);
    assert.ok(legal.includes('offer') && legal.includes('terms-of-use'), `${locale}: подвал без оферты/условий`);
    for (const slug of legal) assert.ok(legalSlugs.has(slug), `${locale}: /legal/${slug} не существует`);
    // Правила Story‑Tales опубликованы (20.10.2026): ссылка, а не пометка.
    assert.ok(legal.includes('story-tales-rules'), `${locale}: нет ссылки на Правила Story‑Tales`);
    assert.match(decode(html), new RegExp(`/legal/story-tales-rules">${t.footer.narratorConsent}</a>`), `${locale}: подпись ссылки на правила`);
    assert.ok(!html.includes(t.footer.consentNote), `${locale}: «правила будут опубликованы» при опубликованных правилах`);
    assert.ok(html.includes('ФОП Тарасенко Андрій Євгенійович'), `${locale}: нет оператора`);
    // Р-STL-19: на незаполненные реквизиты оферты не ссылаемся.
    assert.doesNotMatch(html, /Реквизиты|Реквізити|Details are in|Angaben im|Datos en la/, `${locale}: отсылка к реквизитам`);
    assert.equal(html.includes(t.footer.legalNoticeOtherLocale), locale !== 'ru', `${locale}: пометка о языке документов`);

    // ── внешних хостов нет ──
    for (const [, raw] of html.matchAll(/href="([^"]+)"/g)) {
      const href = decode(raw);
      const ok =
        href.startsWith('#') ||
        /^\/(?!\/)/.test(href) ||
        href === `${TMA_URL}?entry=stories#/stories` ||
        href === TG_HREF ||
        href === `https://t.me/${BOT}`;
      assert.ok(ok, `${locale}: внешняя ссылка ${href}`);
    }
    assert.doesNotMatch(html, /src="https?:/, `${locale}: внешний ресурс`);

    // ── метаданные ──
    const meta = await generateMetadata({ params: Promise.resolve({ locale }) });
    if (MODE !== 'closed') {
      assert.deepEqual(meta.robots, { index: true, follow: true }, `${locale}: robots в public`);
    } else {
      assert.equal(meta.robots, STORIES_ROBOTS, `${locale}: robots`);
    }
    assert.equal(meta.description, A ? A.metaDescription : t.meta.description, `${locale}: description`);
    assert.equal(STORIES_ROBOTS, 'noindex, nofollow, noarchive');
    assert.equal(meta.referrer, STORIES_REFERRER_POLICY, `${locale}: referrer`);
    assert.equal(meta.title, t.meta.title);
    assert.equal(meta.keywords, null, `${locale}: ключевые слова главной унаследуются`);
    assert.equal(meta.alternates?.canonical, storiesPageUrl(locale), `${locale}: canonical`);
    const languages = meta.alternates?.languages as Record<string, string>;
    assert.deepEqual(Object.keys(languages).sort(), [...locales, 'x-default'].sort(), `${locale}: hreflang`);
    for (const l of locales) assert.equal(languages[l], storiesPageUrl(l), `${locale}: hreflang ${l}`);
    assert.equal(languages['x-default'], storiesPageUrl('ru'));
    const og = meta.openGraph as { url: string; images: Array<{ url: string; width: number; height: number }> };
    assert.equal(og.url, storiesPageUrl(locale));
    assert.deepEqual(
      og.images.map((i) => [i.url, i.width, i.height]),
      [[`${STORIES_SITE_URL}/og/stories-${locale}.jpg`, 1200, 630]],
      `${locale}: OG-картинка не своя`,
    );

    // ── Р-STL-18: файл карточки и отпечаток текстов ──
    const file = path.join(ROOT, 'public', 'og', `stories-${locale}.jpg`);
    assert.ok(fs.existsSync(file), `${locale}: нет ${file} — запустите npx tsx scripts/og-stories-cards.tsx`);
    const buf = fs.readFileSync(file);
    assert.deepEqual(jpegSize(buf), { width: 1200, height: 630 }, `${locale}: карточка не JPEG 1200×630`);
    assert.ok(buf.length <= OG_CARD_BYTES_MAX, `${locale}: карточка ${buf.length} байт — больше бюджета`);
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'og-stories-cards.lock.json'), 'utf8')) as Record<string, string>;
    assert.equal(lock[locale], ogCardFingerprint(t), `${locale}: тексты карточки устарели — перезапустите scripts/og-stories-cards.tsx`);
  }

  assert.equal(viewport.viewportFit, 'cover', 'safe-area: viewport-fit=cover');
  // В `closed` в API не ходим; в pilot/public — только за capabilities.
  if (MODE === 'closed') assert.deepEqual(capsRequests, [], 'closed: запрос к API');
  else assert.ok(capsRequests.length > 0 && capsRequests.every((u) => u.endsWith('/public/story-capabilities')), `${MODE}: запросы ${capsRequests.join(', ')}`);

  // ── S3-7: словарь главной в RSC-данных страницы ──
  // Предки страницы — корневой layout и `(stories)/[locale]/layout.tsx`;
  // клиентского провайдера словаря (`DictionaryProvider` получает
  // `clientDictionary` — он уходит в HTML) у них нет, а компоненты
  // страницы словарь не читают.
  const layoutCode = fs.readFileSync(LAYOUT_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(layoutCode, /DictionaryProvider|clientDictionary|getDictionary|dictionary-context/, 'S3-7: layout Story‑Tales отдаёт словарь главной');
  assert.match(layoutCode, /<HtmlDocument locale=\{locale\}>/, 'layout Story‑Tales без HtmlDocument');
  for (const file of fs.readdirSync(PAGE_DIR)) {
    const src = fs.readFileSync(path.join(PAGE_DIR, file), 'utf8');
    assert.doesNotMatch(src, /useDictionary|get-dictionary|dictionary-context/, `${file}: словарь главной на странице Story‑Tales`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'app', '[locale]', 'stories')), 'S3-7: страница вернулась под общий [locale]/layout');

  // ── Р-STL-8: ни аналитики, ни консультанта, ни сторонних скриптов ──
  for (const file of fs.readdirSync(PAGE_DIR)) {
    const src = fs.readFileSync(path.join(PAGE_DIR, file), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    for (const re of [/next\/script/, /Assist/, /Track\b/, /analytics/i, /gtag|ym\(|fbq|posthog|plausible|metrika/i, /sendBeacon/, /fetch\(/]) {
      assert.doesNotMatch(code, re, `${file}: ${re} — аналитика v1 не отправляется (Р-STL-8)`);
    }
  }
  // Клиентский компонент — ровно один (выбор языка).
  const client = fs
    .readdirSync(PAGE_DIR)
    .filter((f) => /^['"]use client['"]/.test(fs.readFileSync(path.join(PAGE_DIR, f), 'utf8').trimStart()));
  assert.deepEqual(client, ['StoriesLocaleMenu.tsx'], 'клиентских компонентов больше одного');

  console.log(`stories-page [${MODE}/${SCENARIO}${MODE === 'closed' ? '' : `/caps:${CAPS_API}`}]: 5 локалей — lang, режим prep без Play/формы/покупки, основной CTA, «Запуск», слоган, FAQ, язык, подвал, метаданные ${MODE !== "closed" ? "index" : "noindex"}, OG-карточка, без аналитики`);

  if (SCENARIO === 'telegram' && MODE === 'closed') {
    const runChild = (extra: Record<string, string>, label: string, drop: string[] = []) => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
      for (const key of drop) delete env[key];
      const child = spawnSync('npx', ['tsx', __filename], { env, encoding: 'utf8' });
      process.stdout.write(child.stdout);
      process.stderr.write(child.stderr);
      assert.equal(child.status, 0, `сценарий ${label} упал`);
    };
    // Безопасный откат: боевая сборка без бота и без адреса TMA.
    runChild({ STORIES_PAGE_SCENARIO: 'fallback', NODE_ENV: 'production' }, 'fallback', ['NEXT_PUBLIC_TELEGRAM_BOT_USERNAME', 'NEXT_PUBLIC_TMA_URL']);
    // Режимы лендинга: API недоступен (откат) и API отвечает.
    runChild({ STORY_TALES_LANDING: 'pilot', STORIES_PAGE_CAPS: 'down' }, 'pilot/down');
    runChild({ STORY_TALES_LANDING: 'pilot', STORIES_PAGE_CAPS: 'api' }, 'pilot/api');
    runChild({ STORY_TALES_LANDING: 'public', STORIES_PAGE_CAPS: 'api' }, 'public/api');
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
