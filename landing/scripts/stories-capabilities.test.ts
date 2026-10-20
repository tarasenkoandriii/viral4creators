/**
 * Story‑Tales: блок «что доступно» из `GET /api/public/story-capabilities`
 * (`src/lib/stories/capabilities.ts`, итерация 2, Р-ST3-6).
 *
 *  1. Разбор: конверт `{success, data}` и голые данные; режим только
 *     `pilot`/`public`; языки и форматы — из закрытых списков; негодные
 *     истории отбрасываются по одной; строки обрезаются; цена — только
 *     положительное конечное число.
 *  2. Загрузка никогда не бросает: сеть, таймаут, 404 (backend в `owner`),
 *     не тот конверт, битый JSON — статический откат без историй и цены.
 *  3. Запрос — ровно `<API_BASE_URL>/public/story-capabilities`, с ISR
 *     `revalidate` = `max-age` ответа и таймаутом; без cookie и данных
 *     посетителя.
 *  4. Страница держит `revalidate` литералом, равным константе модуля.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  STATIC_STORY_CAPABILITIES,
  STORY_CAPABILITIES_REVALIDATE_SECONDS,
  loadStoryCapabilities,
  parseStoryCapabilities,
  taleTitle,
} from '../src/lib/stories/capabilities';

const ROOT = path.join(__dirname, '..');
const DATA = {
  mode: 'pilot',
  languages: ['ru', 'uk', 'fr'],
  tales: [
    { slug: 'mitten', title: 'Рукавичка', titles: { ru: 'Рукавичка', uk: 'Рукавичка' }, languages: ['ru', 'uk'], formats: ['audio', 'video'] },
    { slug: 'turnip', title: `  Репка\n${'я'.repeat(200)}`, languages: ['ru'] },
    { slug: 'mitten', title: 'дубль', languages: ['ru'] },
    { slug: '../etc', title: 'x', languages: ['ru'] },
    { slug: 'pigs', title: 'Три поросёнка', languages: ['fr'] },
    { slug: 'lantern', title: '', languages: ['ru'] },
    'junk',
    null,
  ],
  formats: ['audio', 'video', 'audio', 'vr'],
  priceFromUsd: 2.99,
};

let passed = 0;
async function it(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log('  ✓', name);
}
const json = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function main() {
  await it('разбор: конверт и голые данные, закрытые списки, отбор историй', () => {
    for (const body of [{ success: true, data: DATA }, DATA]) {
      const caps = parseStoryCapabilities(body);
      assert.ok(caps);
      assert.equal(caps.source, 'api');
      assert.deepEqual(caps.languages, ['ru', 'uk']);
      assert.deepEqual(caps.formats, ['audio', 'video']);
      assert.deepEqual(caps.tales.map((t) => t.slug), ['mitten', 'turnip']);
      assert.equal(caps.tales[1].title.length, 120, 'название не обрезано');
      assert.ok(!caps.tales[1].title.includes('\n'), 'перевод строки в названии');
      assert.equal(caps.priceFromUsd, 2.99);
      assert.equal(taleTitle(caps.tales[0], 'uk'), 'Рукавичка');
      assert.equal(taleTitle(caps.tales[1], 'uk'), caps.tales[1].title, 'без перевода — основное название');
    }
    assert.equal(parseStoryCapabilities({ ...DATA, mode: 'public' })?.source, 'api');
  });

  await it('разбор: нет данных — null (дальше откат)', () => {
    for (const body of [
      null,
      'x',
      [],
      { success: false, error: { message: 'Not Found' } },
      { success: true, data: null },
      { ...DATA, mode: 'owner' },
      { ...DATA, mode: undefined },
      { ...DATA, languages: ['fr'] },
      { ...DATA, languages: 'ru' },
    ]) {
      assert.equal(parseStoryCapabilities(body), null, JSON.stringify(body)?.slice(0, 60));
    }
  });

  await it('разбор: цена — только положительное конечное число', () => {
    for (const price of [0, -1, Number.NaN, '2.99', null, 5000, Infinity]) {
      assert.equal(parseStoryCapabilities({ ...DATA, priceFromUsd: price })?.priceFromUsd, null, String(price));
    }
  });

  await it('загрузка: любые сбои — статический откат, сборка не падает', async () => {
    const cases: Array<[string, typeof fetch]> = [
      ['сеть', (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch],
      ['таймаут', (async () => {
        throw new DOMException('timeout', 'TimeoutError');
      }) as typeof fetch],
      ['404 owner', (async () => json({ success: false, error: { message: 'Not Found' } }, 404)) as typeof fetch],
      ['500', (async () => json('oops', 500)) as typeof fetch],
      ['битый JSON', (async () => json('{"success":tr', 200)) as typeof fetch],
      ['не тот конверт', (async () => json({ success: true, data: { mode: 'owner' } })) as typeof fetch],
    ];
    for (const [label, impl] of cases) {
      assert.deepEqual(await loadStoryCapabilities(impl), STATIC_STORY_CAPABILITIES, label);
    }
    assert.deepEqual(STATIC_STORY_CAPABILITIES, { source: 'static', languages: ['ru', 'uk'], tales: [], formats: [], priceFromUsd: null });
    assert.ok(Object.isFrozen(STATIC_STORY_CAPABILITIES));
  });

  await it('загрузка: адрес, ISR и таймаут; без cookie', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const caps = await loadStoryCapabilities((async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(url), init ?? {}]);
      return json({ success: true, data: DATA });
    }) as typeof fetch);
    assert.equal(caps.source, 'api');
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.match(url, /^https?:\/\/[^?#]+\/api\/public\/story-capabilities$/);
    assert.equal(init.next?.revalidate, STORY_CAPABILITIES_REVALIDATE_SECONDS);
    assert.equal(STORY_CAPABILITIES_REVALIDATE_SECONDS, 300, 'интервал ≠ max-age ответа API');
    assert.ok(init.signal instanceof AbortSignal, 'нет таймаута');
    assert.equal(init.credentials, undefined);
    assert.equal(init.headers, undefined, 'в API уходят заголовки посетителя');
  });

  await it('страница: revalidate литералом = константе', () => {
    const page = fs.readFileSync(path.join(ROOT, 'src', 'app', '(stories)', '[locale]', 'stories', 'page.tsx'), 'utf8');
    const literal = /^export const revalidate = (\d+);$/m.exec(page)?.[1];
    assert.equal(Number(literal), STORY_CAPABILITIES_REVALIDATE_SECONDS);
  });

  console.log(`stories-capabilities: ${passed} проверок пройдено`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
