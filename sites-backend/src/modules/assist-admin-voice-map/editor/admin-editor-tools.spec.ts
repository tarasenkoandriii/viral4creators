/**
 * Заход 13 (хвост Р-З11-А11) — чистые части инструментов панели `wa.`:
 * журнал «Админки» → свёртка «Промахов» общим ядром, пороги «Пропозицій»
 * «Админки», запись мемо АМ-N кликами (шаги `ui` без серверного эффекта,
 * слоты без значений, стоп на кнопке «Зберегти»), шаги панели ↔ черновик
 * (`keep` — только `api`/`say` черновика), «Прогнати» по снимку.
 */
import { parseAdminMemo } from '../../assist-admin-actions/admin-memo';
import { defaultAdminRules } from '../../assist-admin-voice/admin-voice-rules';
import {
  buildSynonymPrompt,
  suggestionCards,
  SITE_SUGGESTION_THRESHOLDS,
  type AskedItem,
  type WrongItem,
} from '../../assist-ui-core/editor-assist';
import {
  mapMissStats,
  mapMissWrongs,
} from '../../assist-ui-core/map-misses-core';
import type { UiSnapshot } from '../../assist-ui-core/types';
import type { VoiceMapTarget } from '../../assist-ui-core/voice-map';
import {
  ADMIN_EDITOR_ASSIST,
  adminSynonymLangs,
} from './admin-editor-assist.service';
import {
  adminMissRows,
  adminPhrasePd,
  askedPlanRows,
  type AdminJournalRow,
} from './admin-map-misses';
import {
  adminMemoTry,
  draftFromPanel,
  panelSteps,
  recordAdminUiStep,
  type AdminRecordInput,
} from './admin-memo-record';

const HOST = 'admin.shop.example';
const t0 = Date.parse('2026-10-09T10:00:00Z');
const at = (s: number) => new Date(t0 + s * 1000);

function row(
  s: number,
  kind: 'ui-plan' | 'ui-step',
  operation: string,
  outcome: string,
  req: Record<string, unknown>,
  error: string | null = null,
): AdminJournalRow {
  return { at: at(s), kind, operation, outcome, error, requestMasked: req };
}

describe('журнал «Админки» → «Промахи» (общее ядро свёртки)', () => {
  const rows: AdminJournalRow[] = [
    // План 1: цель `history` найдена, шаг исполнен, через 2 с — стоп кнопкой («не туда»).
    row(0, 'ui-plan', 'ui.plan', 'confirmed', {
      plan: 'p1',
      page: '/admin/orders/1',
      mapKey: 'history',
      mapMiss: false,
      notes: [],
    }),
    row(1, 'ui-step', 'ui.click', 'done', {
      plan: 'p1',
      mapKey: 'history',
      url: `https://${HOST}/admin/orders/1`,
    }),
    row(3, 'ui-plan', 'ui.stop', 'stopped', { plan: 'p1', by: 'button' }),
    // План 2: «нажмите сами» по `track`.
    row(10, 'ui-step', 'ui.click', 'manual', { plan: 'p2', mapKey: 'track' }),
    // План 3: шаг не нашёл цель; монитор — `expect_miss` → failed.
    row(
      20,
      'ui-step',
      'ui.click',
      'failed',
      { plan: 'p3', mapKey: 'track' },
      'no_target',
    ),
    row(
      21,
      'ui-step',
      'ui.fill',
      'expect_miss',
      { plan: 'p3', mapKey: 'note' },
      'expect',
    ),
    // План 4: промах карты (цель названа, на странице нет) и 0 шагов.
    row(30, 'ui-plan', 'ui.plan', 'refused', {
      plan: 'p4',
      page: '/admin/orders/2',
      mapKey: 'export',
      mapMiss: true,
      notes: ['no_target'],
    }),
    // План 5: отказ по запрету — не «просили, не нашли».
    row(40, 'ui-plan', 'ui.plan', 'refused', {
      plan: 'p5',
      page: '/admin/orders/2',
      mapKey: null,
      mapMiss: false,
      notes: ['danger'],
    }),
    // Мастер, сухой прогон и уход в API — не сигнал.
    row(50, 'ui-step', 'ui.click', 'manual', {
      plan: 'p6',
      test: 't1',
      mapKey: 'track',
    }),
    row(51, 'ui-plan', 'ui.plan', 'dryrun', {
      plan: 'p7',
      mapKey: 'x',
      mapMiss: true,
    }),
    row(52, 'ui-plan', 'ui.plan', 'api', { plan: '-', api: 'shop.getOrder' }),
    // Нарушение запрета — служебная строка (не «нажмите сами»).
    row(
      60,
      'ui-step',
      'ui.click',
      'violation',
      { plan: 'p8', mapKey: 'track' },
      'never',
    ),
    // Чужие виды журнала — мимо.
    row(70, 'ui-plan' as never, 'shop.getOrder', 'ok', { plan: 'p9' }),
  ];
  rows[rows.length - 1].kind = 'read';

  it('строки журнала → строки ядра: мастер/сухие/API/чужие — вон; стоп — с причиной `by`', () => {
    const m = adminMissRows(rows);
    expect(m.map((r) => r.planId)).not.toEqual(
      expect.arrayContaining(['p6', 'p7', '-', 'p9']),
    );
    expect(m.find((r) => r.action === 'stop')).toMatchObject({
      planId: 'p1',
      reason: 'button',
    });
    expect(
      m.find((r) => r.planId === 'p3' && r.mapKey === 'note'),
    ).toMatchObject({ result: 'failed' });
    expect(m.find((r) => r.planId === 'p8')).toMatchObject({
      action: 'violation',
    });
  });

  it('свёртка: «не туда», «нажмите сами», «не найдено», промах карты; «просили» — промах и `no_target`, не отказ по запрету', () => {
    const m = adminMissRows(rows);
    const v = mapMissStats(m, { all: true });
    const by = new Map(v.items.map((i) => [i.key, i]));
    expect(by.get('history')).toMatchObject({ wrong: 1, done: 1 });
    expect(by.get('track')).toMatchObject({ self: 1, notFound: 1 });
    expect(by.get('note')).toMatchObject({ self: 1 });
    expect(by.get('export')).toMatchObject({ missed: 1 });
    expect(v.pages).toEqual([
      expect.objectContaining({ page: '/admin/orders/2', misses: 1 }),
    ]);
    expect(mapMissWrongs(m)).toEqual([
      { key: 'history', planId: 'p1', multi: false },
    ]);
    expect(askedPlanRows(m).map((r) => r.planId)).toEqual(['p4']);
  });
});

describe('пороги «Пропозицій» и промпт синонимов «Админки»', () => {
  const asked = (visitors: number, count: number): AskedItem => ({
    id: 'a'.repeat(24),
    phrase: 'експорт замовлень',
    lang: 'uk',
    count,
    visitors,
    key: null,
    last: new Date(t0).toISOString(),
  });
  const wrong = (visitors: number, count: number): WrongItem => ({
    id: 'b'.repeat(24),
    key: 'history',
    phrase: 'журнал',
    lang: 'uk',
    count,
    visitors,
  });

  it('«Сайт» — 3 разных посетителя; «Админка» — 2 сотрудника И 3 повтора (аудит P3-3); «не туда» — 2 сотрудника', () => {
    const none = new Set<string>();
    expect(suggestionCards([asked(1, 5)], [], none)).toEqual([]);
    expect(
      suggestionCards([asked(1, 5)], [], none, {}, SITE_SUGGESTION_THRESHOLDS),
    ).toEqual([]);
    const th = ADMIN_EDITOR_ASSIST.thresholds;
    // Один сотрудник сколько угодно раз — нет; два сотрудника, но 2 раза — нет.
    expect(suggestionCards([asked(1, 9)], [], none, {}, th)).toEqual([]);
    expect(suggestionCards([asked(2, 2)], [], none, {}, th)).toEqual([]);
    expect(suggestionCards([asked(2, 3)], [], none, {}, th)).toHaveLength(1);
    expect(suggestionCards([], [], none, { wrong: [wrong(1, 5)] }, th)).toEqual(
      [],
    );
    expect(suggestionCards([], [], none, { wrong: [wrong(2, 2)] }, th)).toEqual(
      [expect.objectContaining({ kind: 'wrong', key: 'history' })],
    );
    // Отклонённое — не показывается и «Админке».
    expect(
      suggestionCards([asked(5, 9)], [], new Set(['a'.repeat(24)]), {}, th),
    ).toEqual([]);
  });

  it('аудит P3-3: команда с именем или номером клиента — не кандидат в синоним «Админки»', () => {
    for (const u of [
      'відкрий клієнта Іван Петренко',
      'відкрий замовлення 1042',
      'покажи «Олена» замовлення',
      'зателефонуй [телефон]',
      'знайди •••',
    ])
      expect([u, adminPhrasePd(u)]).toEqual([u, true]);
    for (const u of [
      'Відкрий експорт замовлень',
      'покажи журнал змін',
      'відкрий 12 замовлення',
    ])
      expect([u, adminPhrasePd(u)]).toEqual([u, false]);
  });

  it('языки — uk и ru всегда, en — если есть английское имя; промпт — про сотрудника админки', () => {
    expect(adminSynonymLangs({ names: { uk: 'Історія' } })).toEqual([
      'uk',
      'ru',
    ]);
    expect(adminSynonymLangs({ names: { en: 'History' } })).toEqual([
      'uk',
      'ru',
      'en',
    ]);
    const t = {
      key: 'history',
      descriptor: { tag: 'button', role: 'tab', text: 'Історія' },
      names: { uk: 'Історія' },
      synonyms: {},
      semanticType: null,
    } as unknown as VoiceMapTarget;
    expect(
      buildSynonymPrompt(t, ['uk'], '/admin/*', 'employee').system,
    ).toMatch(/EMPLOYEE working in the admin panel/);
    expect(buildSynonymPrompt(t, ['uk'], '/').system).toMatch(
      /website visitor/,
    );
  });
});

describe('мемо АМ-N записью кликами', () => {
  const rules = defaultAdminRules();
  const base = (
    descriptor: Record<string, unknown>,
    extra: Partial<AdminRecordInput> = {},
  ): AdminRecordInput => ({
    descriptor: { unique: true, ...descriptor },
    path: '/admin/orders/1042',
    hosts: [HOST],
    rules,
    mapTarget: null,
    takenSlots: [],
    count: 0,
    ...extra,
  });

  it('ссылка/вкладка — шаг `click` (исполняется по-настоящему); поле — слот без значения; список — слот `option`', () => {
    const link = recordAdminUiStep(
      base({
        tag: 'a',
        role: 'link',
        text: 'Клієнти',
        hrefPath: '/admin/customers',
        hrefHost: HOST,
      }),
    );
    expect(link).toMatchObject({
      kind: 'step',
      exec: true,
      step: {
        action: 'click',
        target: { pin: { text: 'Клієнти' }, role: 'link' },
        value: null,
      },
    });
    const tab = recordAdminUiStep(
      base({ tag: 'button', role: 'tab', text: 'Історія', toggle: true }),
    );
    expect(tab).toMatchObject({ kind: 'step', step: { action: 'click' } });
    const fill = recordAdminUiStep(
      base(
        {
          tag: 'input',
          role: 'textbox',
          text: 'Трек-номер',
          inputType: 'text',
        },
        { fieldName: 'tracking_number' },
      ),
    );
    expect(fill).toMatchObject({
      kind: 'step',
      exec: false,
      slot: { name: 'tracking_number', kind: 'text', pii: false },
      step: { action: 'fill', value: { slot: 'tracking_number' } },
    });
    const phone = recordAdminUiStep(
      base({
        tag: 'input',
        role: 'textbox',
        text: 'Телефон клієнта',
        inputType: 'tel',
      }),
    );
    // e-mail/телефон у «Админки» — слот `text`, ПД отмечены.
    expect(phone).toMatchObject({ slot: { kind: 'text', pii: true } });
    const sel = recordAdminUiStep(
      base(
        { tag: 'select', role: 'combobox', text: 'Статус' },
        { options: ['Новий', 'Оплачено'] },
      ),
    );
    expect(sel).toMatchObject({
      slot: {
        kind: 'option',
        options: [{ value: 'Новий' }, { value: 'Оплачено' }],
      },
    });
  });

  it('аудит P2-1: флажок/переключатель — при записи не нажимается; switch и флажок вне формы — стоп (сохраняются сразу); подложенный switch — 422', () => {
    const inForm = recordAdminUiStep(
      base({
        tag: 'input',
        role: 'checkbox',
        inputType: 'checkbox',
        text: 'Терміново',
        inForm: true,
      }),
    );
    expect(inForm).toMatchObject({
      kind: 'step',
      exec: false,
      step: { action: 'check' },
    });
    for (const d of [
      { tag: 'button', role: 'switch', text: 'Активний', inForm: true },
      {
        tag: 'input',
        role: 'checkbox',
        inputType: 'checkbox',
        text: 'Опубліковано',
      },
      { tag: 'input', role: 'radio', inputType: 'radio', text: 'Заблокувати' },
    ])
      expect(recordAdminUiStep(base(d))).toEqual({
        kind: 'stop',
        reason: 'server_effect',
        step: null,
      });
    // Ссылка/вкладка — по-прежнему по-настоящему (переход).
    expect(
      recordAdminUiStep(
        base({ tag: 'button', role: 'tab', text: 'Історія', toggle: true }),
      ),
    ).toMatchObject({ kind: 'step', exec: true });
    expect(
      parseAdminMemo({
        steps: [
          {
            action: 'ui',
            kind: 'check',
            target: { assistId: null, text: 'Активний', role: 'switch' },
            value: null,
          },
        ],
      }).issues.map((i) => i.code),
    ).toContain('click_forbidden');
  });

  it('аудит P3-3: элемент строки таблицы без `data-assist-id` — не пишется (подпись = ПД клиента); с разметкой — шаг', () => {
    const link = {
      tag: 'a',
      role: 'link',
      text: 'Іван Петренко',
      hrefPath: '/admin/customers/55',
      hrefHost: HOST,
    };
    expect(recordAdminUiStep(base(link, { row: true }))).toEqual({
      kind: 'skip',
      code: 'row',
    });
    expect(
      recordAdminUiStep(
        base(
          { ...link, text: 'Картка', assistId: 'customer-card' },
          { row: true },
        ),
      ),
    ).toMatchObject({ kind: 'step' });
  });

  it('кнопка «Зберегти»/с эффектом — стоп `server_effect`; «Видалити», пароль, чужой хост, never, denylist, зона — стоп', () => {
    const r = (d: Record<string, unknown>, x: Partial<AdminRecordInput> = {}) =>
      recordAdminUiStep(base(d, x));
    expect(
      r({ tag: 'button', role: 'button', text: 'Зберегти', submit: true }),
    ).toEqual({ kind: 'stop', reason: 'server_effect', step: null });
    expect(
      r({ tag: 'button', role: 'button', text: 'Додати нотатку' }),
    ).toEqual(
      expect.objectContaining({ kind: 'stop', reason: 'server_effect' }),
    );
    // Массовое действие — стоп-лист «Админки» («никогда»).
    expect(r({ tag: 'button', role: 'button', text: 'Вибрати все' })).toEqual(
      expect.objectContaining({ kind: 'stop', reason: 'danger' }),
    );
    expect(
      r({ tag: 'button', role: 'button', text: 'Видалити замовлення' }),
    ).toEqual(expect.objectContaining({ kind: 'stop' }));
    expect(r({ tag: 'input', inputType: 'password', text: 'Пароль' })).toEqual(
      expect.objectContaining({ reason: 'sensitive_field' }),
    );
    expect(
      r({
        tag: 'a',
        role: 'link',
        text: 'Документація',
        hrefPath: '/help',
        hrefHost: 'docs.other.example',
        offHost: true,
      }),
    ).toEqual(expect.objectContaining({ kind: 'stop' }));
    expect(
      r({ tag: 'a', role: 'link', text: 'Клієнти', neverAttr: true }),
    ).toEqual(expect.objectContaining({ reason: 'never_attr' }));
    expect(
      r(
        {
          tag: 'a',
          role: 'link',
          text: 'Клієнти',
          hrefPath: '/admin/customers',
        },
        {
          mapTarget: { denylisted: true } as unknown as VoiceMapTarget,
        },
      ),
    ).toEqual(expect.objectContaining({ reason: 'denylist' }));
    expect(
      r(
        {
          tag: 'a',
          role: 'link',
          text: 'Клієнти',
          hrefPath: '/admin/customers',
        },
        { rules: { ...rules, denyPaths: ['/admin/orders/*'] } },
      ),
    ).toEqual(expect.objectContaining({ reason: 'zone' }));
    expect(
      r(
        {
          tag: 'a',
          role: 'link',
          text: 'Клієнти',
          hrefPath: '/admin/customers',
        },
        { count: 10 },
      ),
    ).toEqual(expect.objectContaining({ reason: 'too_many_steps' }));
  });

  it('шаги панели ↔ черновик: `api`/`say` — по `keep` из черновика (подделка — `keep_invalid`); слоты — только используемые', () => {
    const prev = parseAdminMemo({
      names: { uk: 'Статус' },
      goal: { text: { uk: 'Статус змінено' } },
      slots: [
        { name: 'order', kind: 'number' },
        { name: 'old', kind: 'text' },
      ],
      steps: [
        {
          action: 'api',
          op: 'op1',
          opKey: 'shop.updateOrderStatus',
          args: { id: { slot: 'order' } },
        },
        { action: 'say', say: { uk: 'Готово' } },
      ],
    }).content;
    const ps = panelSteps(prev, 'uk');
    expect(ps).toEqual([
      expect.objectContaining({
        action: 'api',
        keep: 0,
        target: expect.objectContaining({
          pin: { text: 'shop.updateOrderStatus' },
        }),
      }),
      expect.objectContaining({ action: 'say', keep: 1 }),
    ]);
    const ui = {
      action: 'click',
      page: '',
      target: { pin: { text: 'Історія' }, assistId: null, role: 'tab' },
      value: null,
      expect: null,
    };
    const fill = {
      action: 'fill',
      page: '',
      target: { pin: { text: 'Трек' }, assistId: null, role: 'textbox' },
      value: { slot: 'track' },
      expect: null,
    };
    const d = draftFromPanel(
      prev,
      [ui, fill, ps[0]],
      [{ name: 'track', kind: 'text', pii: false, options: [] }],
    );
    expect(d.issues).toEqual([]);
    expect(d.slots.map((s) => (s as { name: string }).name)).toEqual([
      'order',
      'track',
    ]);
    const parsed = parseAdminMemo({
      names: { uk: 'x' },
      goal: { text: { uk: 'y' } },
      slots: d.slots,
      steps: d.steps,
    });
    expect(parsed.issues).toEqual([]);
    expect(parsed.content.steps.map((s) => s.action)).toEqual([
      'ui',
      'ui',
      'api',
    ]);
    // Подделка: `keep` на шаг `ui`, несуществующий или повтор — отказ.
    for (const keep of [5, -1, 1.5])
      expect(draftFromPanel(prev, [{ ...ui, keep }], []).issues).toEqual([
        { path: 'steps[0].keep', code: 'keep_invalid' },
      ]);
    expect(
      draftFromPanel(prev, [ps[0], ps[0]], []).issues.map((i) => i.code),
    ).toEqual(['keep_invalid']);
    // `keep` на шаг `ui` черновика — тоже подделка (шаг `ui` — из полей панели).
    const withUi = parseAdminMemo({
      steps: [
        {
          action: 'ui',
          kind: 'click',
          target: { assistId: null, text: 'Історія', role: 'tab' },
          value: null,
        },
      ],
    }).content;
    expect(draftFromPanel(withUi, [{ ...ui, keep: 0 }], []).issues).toEqual([
      { path: 'steps[0].keep', code: 'keep_invalid' },
    ]);
    // Без черновика `keep` не действует.
    expect(draftFromPanel(null, [ps[1]], []).issues).toHaveLength(1);
    // Шаг-клик по кнопке «Зберегти», подложенный панелью, — строгий разбор кабинета.
    const save = draftFromPanel(
      null,
      [
        {
          ...ui,
          target: { pin: { text: 'Зберегти' }, assistId: null, role: 'button' },
        },
      ],
      [],
    );
    expect(
      parseAdminMemo({ steps: save.steps }).issues.map((i) => i.code),
    ).toContain('click_forbidden');
  });

  it('«Прогнати»: шаги по снимку до перехода (дальше — следующая страница); нет цели — стоп; `api` — пропуск', () => {
    const snap: UiSnapshot = {
      url: `https://${HOST}/admin/orders/1042`,
      title: 'Замовлення',
      elements: [
        {
          ref: 'e1',
          role: 'tab',
          tag: 'button',
          text: 'Історія',
          inView: true,
          toggle: true,
        },
        {
          ref: 'e2',
          role: 'textbox',
          tag: 'input',
          text: 'Трек',
          inView: true,
          inputType: 'text',
        },
        {
          ref: 'e3',
          role: 'link',
          tag: 'a',
          text: 'Клієнти',
          inView: true,
          href: `https://${HOST}/admin/customers`,
        },
      ],
    } as unknown as UiSnapshot;
    const c = parseAdminMemo({
      names: { uk: 'x' },
      goal: { text: { uk: 'y' } },
      slots: [{ name: 'track', kind: 'text' }],
      steps: [
        {
          action: 'ui',
          kind: 'click',
          target: { assistId: null, text: 'Історія', role: 'tab' },
          value: null,
        },
        {
          action: 'ui',
          kind: 'fill',
          target: { assistId: null, text: 'Трек', role: 'textbox' },
          value: { slot: 'track' },
        },
        { action: 'say', say: { uk: 'Ок' } },
        {
          action: 'ui',
          kind: 'click',
          target: { assistId: null, text: 'Клієнти', role: 'link' },
          value: null,
        },
        {
          action: 'ui',
          kind: 'click',
          target: { assistId: null, text: 'Пошук', role: 'tab' },
          value: null,
        },
      ],
    }).content;
    const ctx = { rules: defaultAdminRules(), hosts: [HOST] };
    const v = adminMemoTry(c, snap, ctx, 0);
    expect(v.steps.map((s) => [s.i, s.ok, s.ref])).toEqual([
      [0, true, 'e1'],
      [1, true, 'e2'],
      [2, true, null],
      [3, true, 'e3'],
    ]);
    expect(v.next).toEqual({ i: 4, page: '/admin/customers' });
    expect(v.done).toBe(false);
    // С шага 4 на этой странице цели нет.
    const miss = adminMemoTry(c, snap, ctx, 4);
    expect(miss).toMatchObject({ stopAt: 4, problem: 'no_target' });
    // Снимок не с хоста админки — сразу отказ.
    expect(
      adminMemoTry(c, { ...snap, url: 'https://evil.example/x' }, ctx, 0),
    ).toMatchObject({ stopAt: 0, problem: 'offhost' });
  });
});
