/**
 * Демо обучающего лендинга (`/site-tutorial`) за флагом
 * (`src/lib/site-tutorial-demo.ts`, черновик сценариев —
 * `doc/TUTORIAL-LANDING-DEMO-SCENARIO-DRAFT.md`).
 *
 * Что держит этот тест:
 *  1. флаг выключен по умолчанию и включается только явным значением;
 *  2. галерея ходит ТОЛЬКО за слотами `site-tutorial-demo-*` — ни за
 *     рекламными шагами, ни за `client-site`; число слотов совпадает с
 *     бэкендом;
 *  3. без роликов секция честно говорит «скоро» и ведёт к схемам, с
 *     роликами — показывает плеер и подпись «сайт — наш полигон»;
 *  4. словари пяти локалей совпадают по форме целиком;
 *  5. страница рисует галерею только под флагом, схемы остаются;
 *  6. оговорка над схемами следует за флагом: без галереи — «схемы, а
 *     не интерфейс», с галереей — «настоящий интерфейс в роликах ниже»,
 *     настоящие кадры важнее обоих.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { howLeadKey, siteTutorialDemoEnabled } from '../src/lib/site-tutorial-demo';
import { SITE_TUTORIAL_DEMO_KEYS, loadTutorialDemos, type TutorialDemoFeed } from '../src/lib/tutorial-demo-api';
import { getDictionary } from '../src/lib/get-dictionary';
import { locales } from '../src/lib/i18n';

// См. greeting-sections.test.ts: tsx собирает JSX в `React.createElement`.
(globalThis as { React?: typeof React }).React = React;

const ROOT = path.join(__dirname, '..');

// ── 1. Флаг ──
for (const on of ['on', 'ON', ' 1 ', 'true', 'True']) {
  assert.equal(siteTutorialDemoEnabled(on), true, `«${on}» включает`);
}
for (const off of [undefined, null, '', '0', 'off', 'false', 'yes', 'enabled', 'on;']) {
  assert.equal(siteTutorialDemoEnabled(off), false, `«${String(off)}» не включает`);
}

// ── 2. Слоты: ровно столько, сколько у бэкенда, и только свои ──
{
  const backend = fs.readFileSync(
    path.join(ROOT, '..', 'backend', 'src', 'modules', 'tutorial-help', 'site-tutorial-demo.ts'),
    'utf8',
  );
  const slots = Number(/SITE_TUTORIAL_DEMO_SLOTS = (\d+);/.exec(backend)?.[1]);
  assert.ok(slots > 0, 'шов ослеп: число слотов на бэкенде не найдено');
  assert.match(backend, /`site-tutorial-demo-\$\{i \+ 1\}`/, 'шов ослеп: форма ключа на бэкенде');
  assert.deepEqual(
    [...SITE_TUTORIAL_DEMO_KEYS],
    Array.from({ length: slots }, (_, i) => `site-tutorial-demo-${i + 1}`),
  );
  assert.ok(!SITE_TUTORIAL_DEMO_KEYS.includes('client-site'));
}

async function main() {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  try {
    // Здоровый API, роликов нет — честное «нет», не сбой.
    globalThis.fetch = async (input) => {
      const key = new URL(String(input)).pathname.split('/').pop() as string;
      requested.push(key);
      return Response.json({ success: true, data: { subjectKey: key, locale: 'ru', title: `Слот ${key}`, videoUrl: null, variants: {} } });
    };
    assert.deepEqual(await loadTutorialDemos('siteTutorial', 'ru'), { items: [], failed: false });
    assert.deepEqual(requested, [...SITE_TUTORIAL_DEMO_KEYS]);
    assert.ok(requested.every((key) => key.startsWith('site-tutorial-demo-')));

    // Старый бэкенд без семейства (404 на слоты) — «временно недоступно».
    globalThis.fetch = async () => new Response('not found', { status: 404 });
    assert.deepEqual(await loadTutorialDemos('siteTutorial', 'ru'), { items: [], failed: true });

    // Один слот с роликом — показывается он один.
    globalThis.fetch = async (input) => {
      const key = new URL(String(input)).pathname.split('/').pop() as string;
      return Response.json({
        success: true,
        data: {
          subjectKey: key, locale: 'ru', title: `Слот ${key}`,
          videoUrl: key === 'site-tutorial-demo-2' ? 'https://blob.example/demo2.mp4' : null,
          width: 720, height: 1560,
        },
      });
    };
    const feed = await loadTutorialDemos('siteTutorial', 'ru');
    assert.deepEqual(feed.items.map((item) => item.subjectKey), ['site-tutorial-demo-2']);

    // ── 3. Разметка секции ──
    const { TutorialDemoGallery } = await import('../src/components/TutorialDemoGallery');
    const render = async (locale: (typeof locales)[number], f: TutorialDemoFeed) => {
      const dict = getDictionary(locale);
      const t = dict.siteTutorialLanding.demo;
      const element = await TutorialDemoGallery({ scenario: 'siteTutorial', locale, dict, feed: f, texts: t, note: t.note });
      return element ? renderToStaticMarkup(element) : '';
    };
    for (const locale of locales) {
      const t = getDictionary(locale).siteTutorialLanding.demo;
      const soon = await render(locale, { items: [], failed: false });
      assert.ok(soon.includes(escape(t.title)), `${locale}: заголовок секции`);
      assert.ok(soon.includes(escape(t.unavailable)), `${locale}: «скоро» без роликов`);
      assert.ok(soon.includes('href="#how"'), `${locale}: ссылка на схемы`);
      assert.ok(!soon.includes(escape(t.note)), `${locale}: подписи про ролики без роликов нет`);
      assert.ok(!soon.includes('<video'), `${locale}: пустого плеера нет`);
      // Подписи главной сюда не протекают.
      assert.ok(!soon.includes(escape(getDictionary(locale).demo.unavailable)), `${locale}: текст главной`);

      const failed = await render(locale, { items: [], failed: true });
      assert.ok(failed.includes(escape(t.loadFailed)), `${locale}: сбой — нейтральный текст`);

      const shown = await render(locale, feed);
      assert.ok(shown.includes(escape(t.lead)), `${locale}: подводка при роликах`);
      assert.ok(shown.includes(escape(t.note)), `${locale}: честная подпись под плеером`);
      assert.ok(shown.includes('https://blob.example/demo2.mp4'), `${locale}: ссылка на ролик`);
      assert.ok(!shown.includes(escape(t.unavailable)), `${locale}: «скоро» при роликах не показывается`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// ── 4. Словари пяти локалей совпадают по форме целиком ──
function shape(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return [`${prefix}[${value.length}]`, ...value.flatMap((v, i) => shape(v, `${prefix}[${i}]`))];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [`${prefix}.${k}`, ...shape(v, `${prefix}.${k}`)]);
  }
  return [];
}
{
  const reference = shape(getDictionary('ru')).sort();
  for (const locale of locales) {
    assert.deepEqual(shape(getDictionary(locale)).sort(), reference, `${locale}: форма словаря`);
    const demo = getDictionary(locale).siteTutorialLanding.demo as Record<string, unknown>;
    for (const key of [...Object.keys(getDictionary(locale).demo), 'note']) {
      assert.equal(typeof demo[key], 'string', `${locale}: siteTutorialLanding.demo.${key}`);
      assert.ok((demo[key] as string).trim().length > 0, `${locale}: пустой siteTutorialLanding.demo.${key}`);
    }
  }
}

// ── 5. Страница: галерея только под флагом, схемы на месте ──
{
  const page = fs.readFileSync(path.join(ROOT, 'src', 'app', '[locale]', 'site-tutorial', 'page.tsx'), 'utf8');
  assert.match(page, /const demoGallery = siteTutorialDemoFromEnv\(\);/);
  assert.match(page, /\{demoGallery \? \(\s*<TutorialDemoGallery\s+scenario="siteTutorial"/);
  assert.equal((page.match(/<TutorialDemoGallery/g) ?? []).length, 1, 'галерея одна и под флагом');
  assert.ok(!/scenario="ads"/.test(page), 'рекламные шаги на обучающем лендинге не подставляются');
  assert.match(page, /frameImage\(locale, index \+ 1\)/, 'схемы «Как это выглядит» остаются');
  // Оговорка выбирается одной функцией от тех же двух признаков, что
  // рисуют картинки и галерею, — а не отдельным условием рядом.
  assert.match(page, /\{t\.how\[howLeadKey\(realFrames, demoGallery\)\]\}/, 'оговорка следует за флагом');
  assert.ok(!/t\.how\.lead\b/.test(page), 'прямого t.how.lead в обход выбора нет');
}

// ── 6. Оговорка над схемами ──
{
  assert.equal(howLeadKey(false, false), 'lead', 'без галереи — «схемы, а не интерфейс»');
  assert.equal(howLeadKey(false, true), 'leadDemo', 'с галереей — про настоящий интерфейс в роликах');
  assert.equal(howLeadKey(true, false), 'leadReal', 'настоящие кадры');
  assert.equal(howLeadKey(true, true), 'leadReal', 'настоящие кадры важнее галереи');
  for (const locale of locales) {
    const how = getDictionary(locale).siteTutorialLanding.how;
    assert.ok(how.leadDemo.trim().length > 40, `${locale}: how.leadDemo пустой`);
    assert.notEqual(how.leadDemo, how.lead, `${locale}: leadDemo = lead`);
    assert.notEqual(how.leadDemo, how.leadReal, `${locale}: leadDemo = leadReal`);
  }
  // Смысл, а не только форма: русская оговорка с галереей не говорит
  // «взять неоткуда» и говорит про ролики с нашего сайта.
  const ru = getDictionary('ru').siteTutorialLanding.how;
  assert.ok(!ru.leadDemo.includes('неоткуда'), 'leadDemo не повторяет «взять неоткуда»');
  assert.match(ru.leadDemo, /настоящий интерфейс/);
  assert.match(ru.leadDemo, /тестовом сайте/);
}

main().then(() => console.log('site-tutorial-demo: ok'), (error) => {
  console.error(error);
  process.exit(1);
});
