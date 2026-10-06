/**
 * Э6-тер (к): мемо из шаблона платформы и импорт/экспорт мемо в файле карты
 * (ТЗ §5-бис.17 п.6, п.15 п.7). Шаблоны WooCommerce проходят ворота на
 * сайте с подписями целей (и не конфликтуют фразами с целями шаблона карты
 * и друг с другом); экспорт — без `pin`, id, Ш4, предложений; импорт —
 * опасные шаги отклонены с причиной, привязка к чужой карте снята.
 */
import {
  MEMO_LANGS,
  memoGates,
  memoPhrases,
  parseMemoContent,
  phraseNorm,
  type MemoContent,
} from './memo';
import {
  MEMO_IO_LIMITS,
  memoExportItem,
  memoImportItems,
  platformMemoBinds,
  platformMemoDrafts,
} from './memo-io';
import { defaultVoiceControlRules } from './rules';
import {
  contentFingerprint,
  emptyVoiceMap,
  exportPayload,
  PLATFORM_TEMPLATES,
} from './voice-map';

const HOST = 'shop.example.com';
const rules = defaultVoiceControlRules();

/** Фразы целей шаблона карты WooCommerce (`lang:norm`). */
function mapTemplatePhrases(): Set<string> {
  const out = new Set<string>();
  for (const t of PLATFORM_TEMPLATES.woocommerce.targets) {
    const names = (t.names ?? {}) as Record<string, string>;
    const syn = (t.synonyms ?? {}) as Record<string, Array<{ text: string }>>;
    for (const l of MEMO_LANGS) {
      if (names[l]) out.add(`${l}:${phraseNorm(names[l])}`);
      for (const s of syn[l] ?? []) out.add(`${l}:${phraseNorm(s.text)}`);
    }
  }
  return out;
}

const FACTS = {
  'add-to-cart': { text: 'Додати в кошик', page: '/tovar/futbolka/' },
  'nav-cart': { text: 'Кошик 0', href: '/koshyk/' },
  search: { text: 'Пошук товарів' },
  'search-submit': { text: 'Пошук' },
};

describe('шаблоны мемо WooCommerce', () => {
  it('3–4 мемо, нужные факты — разметка плагина и кнопка поиска', () => {
    const memos = PLATFORM_TEMPLATES.woocommerce.memos ?? [];
    expect(memos.length).toBeGreaterThanOrEqual(3);
    expect(memos.length).toBeLessThanOrEqual(4);
    expect(platformMemoBinds('woocommerce').sort()).toEqual([
      'add-to-cart',
      'nav-cart',
      'search',
      'search-submit',
    ]);
    expect(platformMemoDrafts('shopify', FACTS)).toBeNull();
  });
  it('с фактами сайта — проходят ворота; фразы не пересекаются с картой и друг с другом', () => {
    const drafts = platformMemoDrafts('woocommerce', FACTS)!;
    const taken = mapTemplatePhrases();
    const seen = new Map<string, string>();
    for (const d of drafts) {
      const parsed = parseMemoContent(d.raw);
      expect(parsed.issues).toEqual([]);
      expect(d.unresolved).toEqual([]);
      const gate = memoGates(parsed.content, { rules, host: HOST, taken });
      expect({ key: d.key, problems: gate.problems }).toEqual({
        key: d.key,
        problems: [],
      });
      expect(
        gate.computed.pointOfNoReturn === null || d.key === 'find-product',
      ).toBe(true);
      for (const ph of memoPhrases(parsed.content)) {
        const k = `${ph.lang}:${ph.norm}`;
        expect(seen.get(k) ?? d.key).toBe(d.key);
        seen.set(k, d.key);
      }
      // Каждое из uk/ru/en: имя и цель.
      for (const l of MEMO_LANGS) {
        expect(parsed.content.names[l]).toBeTruthy();
        expect(parsed.content.goal.text[l]).toBeTruthy();
      }
    }
  });
  it('пути сайта: корзина — в ссылку и условие адреса, страница товара — маской', () => {
    const drafts = platformMemoDrafts('woocommerce', FACTS)!;
    const c = parseMemoContent(
      drafts.find((d) => d.key === 'add-and-open-cart')!.raw,
    ).content;
    expect(c.steps.map((s) => s.page)).toEqual(['/tovar/*', '/tovar/*']);
    expect(c.steps[0].target?.pin.text).toBe('Додати в кошик');
    expect(c.steps[1].target?.pin.href).toBe('/koshyk/');
    expect(c.steps[1].target?.mapKey).toBe('nav-cart');
    expect(c.goal.expect).toEqual([
      { kind: 'url', path: '/koshyk*' },
      {
        kind: 'counter',
        target: { assistId: 'nav-cart', text: '' },
        delta: 1,
      },
    ]);
    const find = parseMemoContent(
      drafts.find((d) => d.key === 'find-product')!.raw,
    ).content;
    expect(find.goal.expect.map((g) => g.kind)).toEqual(['slot', 'field']);
    expect(find.slots).toEqual([
      { name: 'query', kind: 'text', pii: false, options: [] },
    ]);
  });
  it('без фактов — подписи целей нажатия не найдены: unresolved, ворота держат (`text`)', () => {
    const drafts = platformMemoDrafts('woocommerce', {})!;
    const add = drafts.find((d) => d.key === 'add-and-open-cart')!;
    expect(add.unresolved).toEqual(['add-to-cart', 'nav-cart']);
    const c = parseMemoContent(add.raw).content;
    expect(c.steps[0].page).toBe('/product/*');
    expect(c.goal.expect[0]).toEqual({ kind: 'url', path: '/cart*' });
    const codes = memoGates(c, { rules, host: HOST }).problems.map(
      (p) => p.code,
    );
    expect(codes).toContain('text');
    // Только выбранные ключи.
    expect(
      platformMemoDrafts('woocommerce', FACTS, ['open-cart'])!.map(
        (d) => d.key,
      ),
    ).toEqual(['open-cart']);
  });
});

function sample(): MemoContent {
  return parseMemoContent({
    names: { uk: 'Обрати розмір і покласти в кошик' },
    triggers: { uk: ['розмір і в кошик'] },
    suggested: { uk: ['поклади [тел] у кошик'] },
    goal: {
      text: { uk: 'Товар у кошику' },
      expect: [{ kind: 'counter', target: { assistId: 'nav-cart' }, delta: 1 }],
    },
    slots: [
      {
        name: 'size',
        kind: 'option',
        options: [{ value: 'M', say: { uk: ['м'] } }],
      },
    ],
    steps: [
      {
        page: '/product/*',
        action: 'select',
        target: {
          uiElementId: 'u1234abcd',
          key: 'select:Розмір',
          mapKey: 'size',
          pin: {
            role: 'combobox',
            text: 'Розмір',
            tag: 'select',
            inForm: true,
            stability: 'strong',
          },
        },
        value: { slot: 'size' },
      },
      {
        page: '/product/*',
        action: 'click',
        target: {
          uiElementId: 'u99',
          mapKey: 'add-to-cart',
          pin: {
            role: 'button',
            assistId: 'add-to-cart',
            text: 'В кошик',
            submit: true,
            inForm: true,
            stability: 'medium',
          },
        },
      },
    ],
  }).content;
}

describe('экспорт мемо в файле карты', () => {
  it('без pin, id Ш4, устойчивости, предложенных фраз и статистики', () => {
    const item = memoExportItem({
      key: 'size-cart',
      listed: false,
      content: sample(),
    });
    const json = JSON.stringify(item);
    for (const bad of [
      '"pin"',
      'uiElementId',
      'u1234abcd',
      '"stability"',
      'suggested',
      '[тел]',
      '"number"',
      '"status"',
      '"origin"',
    ])
      expect(json).not.toContain(bad);
    expect(item.key).toBe('size-cart');
    expect(item.listed).toBe(false);
    const steps = item.steps as Array<{ target: Record<string, unknown> }>;
    expect(steps[1].target).toEqual({
      mapKey: 'add-to-cart',
      role: 'button',
      assistId: 'add-to-cart',
      text: 'В кошик',
      tag: 'button',
      href: null,
      inputType: null,
      submit: true,
      inForm: true,
      pd: false,
      toggle: false,
    });
  });
  it('файл карты: `memos` — только если переданы; отпечаток карты мемо не включает', () => {
    const c = emptyVoiceMap();
    expect('memos' in exportPayload(c)).toBe(false);
    expect(exportPayload(c, [{ key: 'x' }]).memos).toEqual([{ key: 'x' }]);
    expect(contentFingerprint(c)).not.toContain('memos');
  });
});

describe('импорт мемо (§5-бис.17 п.15 п.7)', () => {
  const ctx = { rules, host: HOST, mapKeys: new Set(['add-to-cart']) };
  it('экспорт → импорт: то же содержимое, отпечаток собран заново, чужая цель карты снята', () => {
    const item = memoExportItem({
      key: 'size-cart',
      listed: true,
      content: sample(),
    });
    const r = memoImportItems(JSON.parse(JSON.stringify([item])), ctx);
    expect(r.rejected).toEqual([]);
    const c = r.accepted[0].content;
    expect(r.accepted[0].key).toBe('size-cart');
    expect(c.steps[0].target).toEqual({
      uiElementId: null,
      key: null,
      mapKey: null, // `size` в карте этого сайта нет
      pin: {
        role: 'combobox',
        assistId: null,
        text: 'Розмір',
        tag: 'select',
        href: null,
        submit: false,
        inForm: true,
        pd: false,
        inputType: null,
        toggle: false,
        stability: null,
      },
    });
    expect(c.steps[1].target?.mapKey).toBe('add-to-cart');
    expect(c.suggested).toEqual({});
    expect(c.goal).toEqual(sample().goal);
    expect(c.slots).toEqual(sample().slots);
  });
  it('опасные шаги — отказ с причиной, остальные мемо файла принимаются', () => {
    const ok = memoExportItem({ key: 'ok', listed: true, content: sample() });
    const step = (text: string, extra: Record<string, unknown> = {}) => ({
      page: '/checkout',
      action: 'click',
      target: { role: 'button', text, tag: 'button', ...extra },
    });
    const pay = {
      ...ok,
      key: 'pay',
      names: { uk: 'Оплатити замовлення' },
      // «Оплатити» с риском «сразу» — «никогда» (приёмка п.7).
      steps: [{ ...step('Оплатити'), risk: 'auto' }],
    };
    const two = {
      ...ok,
      key: 'two',
      names: { uk: 'Дві заявки' },
      steps: [
        step('Надіслати заявку', { submit: true, inForm: true }),
        step('Надіслати ще', { submit: true, inForm: true }),
      ],
    };
    const lower = {
      ...ok,
      key: 'lower',
      names: { uk: 'Надіслати одразу' },
      steps: [
        { ...step('Надіслати', { submit: true, inForm: true }), risk: 'auto' },
      ],
    };
    const pdConst = {
      ...ok,
      key: 'pd-const',
      names: { uk: 'Мій телефон' },
      steps: [
        {
          page: '/contact',
          action: 'fill',
          target: {
            role: 'textbox',
            text: 'Телефон',
            tag: 'input',
            inputType: 'tel',
            pd: true,
          },
          value: { const: 'Київ' },
        },
      ],
    };
    const r = memoImportItems(
      [
        ok,
        pay,
        two,
        lower,
        pdConst,
        'мусор',
        { ...ok, key: 'bad-lang', names: { de: 'X' } },
      ],
      ctx,
    );
    expect(r.accepted.map((a) => a.index)).toEqual([0]);
    expect(r.rejected.map((x) => [x.index, x.key, x.code])).toEqual([
      [1, 'pay', 'never_step'],
      [2, 'two', 'two_pnr'],
      [3, 'lower', 'risk_lowering_forbidden'],
      [4, 'pd-const', 'const_in_pii'],
      [5, null, 'format'],
      [6, 'bad-lang', 'lang'],
    ]);
  });
  it('без имени — отказ; не массив — пусто; сверх потолка — too_many', () => {
    const ok = memoExportItem({ key: 'ok', listed: true, content: sample() });
    expect(memoImportItems({ memos: [ok] }, ctx)).toEqual({
      accepted: [],
      rejected: [],
    });
    const r = memoImportItems([{ ...ok, names: {} }], ctx);
    expect(r.rejected[0].code).toBe('no_name');
    const many = Array.from({ length: MEMO_IO_LIMITS.memos + 2 }, () => ok);
    const m = memoImportItems(many, ctx);
    expect(m.accepted).toHaveLength(MEMO_IO_LIMITS.memos);
    expect(m.rejected.map((x) => x.code)).toEqual(['too_many', 'too_many']);
  });
  it('риск выше расчёта — можно (только вверх); конфликт фраз не мешает импорту', () => {
    const ok = memoExportItem({ key: 'ok', listed: true, content: sample() });
    const steps = (ok.steps as Array<Record<string, unknown>>).map((s) => ({
      ...s,
      risk: 'confirm',
    }));
    const taken = new Set([`uk:${phraseNorm('розмір і в кошик')}`]);
    const r = memoImportItems([{ ...ok, steps }], { ...ctx, taken });
    expect(r.rejected).toEqual([]);
    expect(r.accepted[0].content.steps.map((s) => s.risk)).toEqual([
      'confirm',
      'confirm',
    ]);
  });
});
