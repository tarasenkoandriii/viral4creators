/**
 * Заход 9 (Э6-тер (8)): сухой прогон голосовой карты «как Т-2» без звука
 * по снимкам образцов и структурный отпечаток шаблона — чистая часть.
 *  - команды: имя + 1 синоним на язык, изменённые цели — первыми, ≤ 30;
 *  - прямой путь выбрал ту цель — ok; конфликт/чужая цель — wrong; цели нет
 *    на образце — missing; прямого пути нет — модель (если передана),
 *    иначе model_skipped; потолок вызовов модели;
 *  - запреты Т-2 — 0 исполнимых шагов;
 *  - отпечаток: образец «чужой» страницы под маской шаблона — mixed.
 */
import { defaultVoiceControlRules } from '../assist-ui-core/rules';
import type { UiSnapElement, UiSnapshot } from '../assist-ui-core/types';
import { parseVoiceMapContent } from '../assist-ui-core/voice-map';
import {
  DRY_RUN_LIMITS,
  dryRunCommands,
  dryRunMap,
  pageSkeleton,
  skeletonSimilarity,
  templateFingerprints,
} from './map-dry-run';

const HOST = 'shop.example.com';
const rules = defaultVoiceControlRules();

let n = 0;
function el(p: Partial<UiSnapElement> & { text: string }): UiSnapElement {
  n++;
  return {
    ref: `e${n}`,
    role: 'button',
    tag: 'button',
    hiddenLabel: null,
    assistId: null,
    inputType: null,
    href: null,
    disabled: false,
    checked: null,
    selected: null,
    options: [],
    heading: null,
    submit: false,
    inForm: false,
    confirmZone: false,
    pd: false,
    toggle: false,
    gesture: null,
    inView: true,
    ...p,
  };
}
const snap = (elements: UiSnapElement[], path: string): UiSnapshot => ({
  url: `https://${HOST}${path}`,
  title: 'Сторінка',
  elements,
});

const btn = (text: string, assistId: string | null = null) => ({
  tag: 'button',
  role: 'button',
  text,
  assistId,
  unique: true,
});

const content = parseVoiceMapContent({
  schemaVersion: 1,
  templates: [
    {
      id: 'tp',
      name: 'Товар',
      pathPattern: '/product/*',
      samplePages: ['/product/1', '/product/2'],
    },
  ],
  targets: [
    {
      key: 'add-to-cart',
      scope: 'template',
      templateId: 'tp',
      descriptor: btn('В кошик', 'add-to-cart'),
      names: { uk: 'В кошик', ru: 'В корзину' },
      synonyms: {
        uk: [
          { text: 'покласти в кошик', origin: 'owner' },
          { text: 'ІІ-синонім', origin: 'suggested' },
        ],
      },
    },
    {
      key: 'reviews',
      scope: 'template',
      templateId: 'tp',
      descriptor: btn('Відгуки', 'reviews'),
      names: { uk: 'Відгуки' },
    },
    {
      key: 'wishlist',
      scope: 'template',
      templateId: 'tp',
      descriptor: btn('Обране', 'wishlist'),
      names: { uk: 'Обране' },
    },
  ],
});

describe('сухой прогон голосовой карты (заход 9)', () => {
  it('команды: имя + 1 своё (не ИИ) синоним на язык; изменённые — первыми; потолок', () => {
    const all = dryRunCommands(content);
    expect(all.map((c) => [c.key, c.lang, c.kind, c.text])).toEqual([
      ['add-to-cart', 'uk', 'name', 'В кошик'],
      ['add-to-cart', 'uk', 'synonym', 'покласти в кошик'],
      ['add-to-cart', 'ru', 'name', 'В корзину'],
      ['reviews', 'uk', 'name', 'Відгуки'],
      ['wishlist', 'uk', 'name', 'Обране'],
    ]);
    const changed = dryRunCommands(content, new Set(['wishlist']), 2);
    expect(changed.map((c) => c.key)).toEqual(['wishlist', 'add-to-cart']);
    expect(DRY_RUN_LIMITS.commands).toBe(30);
  });

  it('прямой путь — ok; цели нет на образце — missing; без прямого пути и без модели — model_skipped; запреты — 0 шагов', async () => {
    const page = snap(
      [
        el({ text: 'В кошик', assistId: 'add-to-cart' }),
        el({ text: 'Відгуки', assistId: 'reviews' }),
        el({ text: 'Оплатити', role: 'button' }),
      ],
      '/product/1',
    );
    const r = await dryRunMap({
      content,
      pages: [{ path: '/product/1', snapshot: page }],
      rules,
      hosts: [HOST],
    });
    const by = Object.fromEntries(
      r.commands.map((c) => [`${c.key}:${c.lang}:${c.kind}`, c.outcome]),
    );
    expect(by).toEqual({
      'add-to-cart:uk:name': 'ok_map',
      'add-to-cart:uk:synonym': 'ok_map',
      'add-to-cart:ru:name': 'ok_map',
      'reviews:uk:name': 'ok_map',
      'wishlist:uk:name': 'missing',
    });
    expect(r).toMatchObject({ ok: 4, failed: 1, skipped: 0, modelCalls: 0 });
    expect(r.forbiddenBlocked).toBe(true);
    expect(r.forbidden.find((f) => f.kind === 'pay')).toMatchObject({
      blocked: true,
      candidates: 1,
    });
  });

  it('прямого пути нет (фраза двух целей) — модель: та цель — ok_model, другая — wrong; потолок вызовов; без модели — skipped', async () => {
    const twin = parseVoiceMapContent({
      schemaVersion: 1,
      targets: [
        {
          key: 'news',
          scope: 'site',
          descriptor: btn('Новини', 'news'),
          names: { uk: 'Новини' },
          synonyms: { uk: [{ text: 'оновлення', origin: 'owner' }] },
        },
        {
          key: 'updates',
          scope: 'site',
          descriptor: btn('Оновлення', 'updates'),
          names: { uk: 'Оновлення' },
        },
      ],
    });
    const page = snap(
      [
        el({ text: 'Новини', assistId: 'news' }),
        el({ text: 'Оновлення', assistId: 'updates' }),
      ],
      '/',
    );
    const refOf = (id: string) =>
      page.elements.find((e) => e.assistId === id)!.ref;
    const prompts: string[] = [];
    const r = await dryRunMap({
      content: twin,
      pages: [{ path: '/', snapshot: page }],
      rules,
      hosts: [HOST],
      model: async (p) => {
        prompts.push(p.user);
        // Модель всегда выбирает «Новини».
        return JSON.stringify({
          command: true,
          steps: [{ kind: 'click', target: refOf('news') }],
        });
      },
    });
    const by = Object.fromEntries(
      r.commands.map((c) => [`${c.key}:${c.kind}`, [c.outcome, c.picked]]),
    );
    expect(by['news:name']).toEqual(['ok_map', 'news']);
    // «оновлення» — фраза двух целей: прямого пути нет, модель выбрала news.
    expect(by['news:synonym']).toEqual(['ok_model', 'news']);
    expect(by['updates:name']).toEqual(['wrong', 'news']);
    expect(r.modelCalls).toBe(2);
    // Данные карты — блоком данных `<voice_map>`, не инструкциями.
    expect(prompts[0]).toContain('<voice_map');
    const none = await dryRunMap({
      content: twin,
      pages: [{ path: '/', snapshot: page }],
      rules,
      hosts: [HOST],
      model: async () => null,
    });
    expect(
      none.commands.filter((c) => c.outcome === 'model_failed'),
    ).toHaveLength(2);
    const skipped = await dryRunMap({
      content: twin,
      pages: [{ path: '/', snapshot: page }],
      rules,
      hosts: [HOST],
      model: null,
    });
    expect(skipped).toMatchObject({ skipped: 2, modelCalls: 0 });
  });

  it('аудит P2-3: срок модели — остаток команд `model_skipped`; одновременно ≤ 3 вызова; каждому — остаток срока', async () => {
    // 8 целей с общей фразой «дублікат» — прямого пути нет ни у одной.
    const many = parseVoiceMapContent({
      schemaVersion: 1,
      targets: Array.from({ length: 8 }, (_, i) => ({
        key: `t${i + 1}`,
        scope: 'site',
        descriptor: btn(`Ціль ${i + 1}`, `t${i + 1}`),
        synonyms: { uk: [{ text: 'дублікат', origin: 'owner' }] },
      })),
    });
    const page = snap(
      Array.from({ length: 8 }, (_, i) =>
        el({ text: `Ціль ${i + 1}`, assistId: `t${i + 1}` }),
      ),
      '/',
    );
    let now = 0;
    let active = 0;
    let peak = 0;
    const budgets: number[] = [];
    const t0 = Date.now();
    const r = await dryRunMap({
      content: many,
      pages: [{ path: '/', snapshot: page }],
      rules,
      hosts: [HOST],
      deadlineMs: 250,
      clock: () => Date.now() - t0 + now,
      model: async (_p, left) => {
        budgets.push(left);
        active++;
        peak = Math.max(peak, active);
        await new Promise((res) => setTimeout(res, 100));
        active--;
        return '{"command": true, "steps": []}';
      },
    });
    const took = Date.now() - t0;
    expect(peak).toBeLessThanOrEqual(DRY_RUN_LIMITS.concurrency);
    // 8 команд по 100 мс, срок 250 мс, по 3 одновременно: две волны
    // успевают (ответ «пусто» — `wrong`), третья обрывается сроком.
    expect(r.failed).toBe(6);
    expect(r.skipped).toBe(2);
    expect(r.commands).toHaveLength(8);
    expect(took).toBeLessThan(250 + 200);
    expect(budgets.every((b) => b <= 250)).toBe(true);
    // Модель зависла дольше срока — команда «без модели», прогон не ждёт.
    now = 0;
    const t1 = Date.now();
    const hung = await dryRunMap({
      content: many,
      pages: [{ path: '/', snapshot: page }],
      rules,
      hosts: [HOST],
      deadlineMs: 150,
      model: () => new Promise<string | null>(() => undefined),
    });
    expect(Date.now() - t1).toBeLessThan(400);
    expect(hung.skipped).toBe(8);
  });

  it('отпечаток шаблона: похожие образцы — один отпечаток; чужая страница под маской — mixed; текст не влияет', () => {
    const product = (title: string) => [
      el({ text: title, role: 'tab' }),
      el({ text: 'В кошик', assistId: 'add-to-cart', inForm: true }),
      el({ text: 'Відгуки', assistId: 'reviews' }),
      el({ text: 'Кошик', role: 'link', tag: 'a' }),
    ];
    const a = snap(product('Футболка'), '/product/1');
    const b = snap(product('Худі'), '/product/2');
    const blog = snap(
      [
        el({ text: 'Стаття', role: 'tab' }),
        el({
          text: 'Підписатися',
          role: 'textbox',
          tag: 'input',
          inForm: true,
        }),
        el({ text: 'Поділитися', role: 'button' }),
      ],
      '/product/blog-post',
    );
    expect(pageSkeleton(a)).toEqual(pageSkeleton(b));
    expect(
      skeletonSimilarity(pageSkeleton(a), pageSkeleton(blog)),
    ).toBeLessThan(DRY_RUN_LIMITS.sameTemplate);
    const fp = templateFingerprints(content, [
      { path: '/product/1', snapshot: a },
      { path: '/product/2', snapshot: b },
      { path: '/product/blog-post', snapshot: blog },
      { path: '/about', snapshot: snap([], '/about') },
    ]);
    expect(fp).toHaveLength(1);
    expect(fp[0]).toMatchObject({ templateId: 'tp', mixed: true });
    expect(fp[0].pages.map((p) => [p.path, p.same])).toEqual([
      ['/product/1', true],
      ['/product/2', true],
      ['/product/blog-post', false],
    ]);
    expect(fp[0].pages[0].fingerprint).toBe(fp[0].pages[1].fingerprint);
    expect(JSON.stringify(fp)).not.toContain('Футболка');
  });
});
