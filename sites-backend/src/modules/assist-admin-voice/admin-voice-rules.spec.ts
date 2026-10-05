/**
 * Чистые правила голосового управления «Админкой» (Э6-бис (б)): строже
 * «Сайта» поверх нейтральных проверок, перечень полей карточки,
 * предпочтение API, мемо-шаги на странице, пробы мастера, билет голоса.
 */
import { checkPlan } from '../assist-ui-core/plan-checks';
import { parseSnapshot } from '../assist-ui-core/snapshot';
import type { UiSnapshot } from '../assist-ui-core/types';
import {
  issueAdminVoiceTicket,
  sniffAdminAudio,
  verifyAdminVoiceTicket,
} from './admin-stt';
import {
  adminDangerButtons,
  adminForbiddenProbes,
  adminizeResolved,
  adminNeverTarget,
  adminMemoUiProblem,
  adminRulesOf,
  apiPreference,
  checkAdminPlan,
  compileAdminMemoUi,
  confirmFields,
  defaultAdminRules,
  modelApiOf,
  parseAdminRules,
  rowNumbersOf,
  type ApiCatalogOp,
} from './admin-voice-rules';

const HOST = 'admin.shop.example';
const el = (
  ref: string,
  role: string,
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  ref,
  role,
  tag:
    role === 'link'
      ? 'a'
      : role === 'textbox'
        ? 'input'
        : role === 'combobox'
          ? 'select'
          : 'button',
  text,
  inView: true,
  ...extra,
});

function page(): UiSnapshot {
  return parseSnapshot({
    url: `https://${HOST}/admin/orders/1042`,
    title: 'Замовлення',
    elements: [
      el('e1', 'link', 'Клієнти', { href: `https://${HOST}/admin/customers` }),
      el('e2', 'textbox', 'Коментар', { inForm: true }),
      el('e3', 'button', 'Зберегти', { submit: true, inForm: true }),
      el('e4', 'button', 'Видалити замовлення'),
      el('e5', 'button', 'В кошик', { assistId: 'add-to-cart' }),
      el('e6', 'textbox', 'Трек-номер'),
      el('e7', 'button', 'Скасувати замовлення'),
      el('e8', 'textbox', 'Пароль менеджера', { inputType: 'text' }),
      el('e9', 'link', 'Чужий сайт', { href: 'https://evil.example/x' }),
    ],
  })!;
}

const base = (steps: unknown[], transcript: string) => ({
  transcript,
  snapshot: page(),
  map: [],
  steps,
  rules: defaultAdminRules(),
  hosts: [HOST],
  state: 'on' as const,
});

const CATALOG: ApiCatalogOp[] = [
  {
    rowId: 'r1',
    key: 'shop.updateOrderStatus',
    operationId: 'updateOrderStatus',
    summary: 'Змінити статус замовлення',
    kind: 'write',
  },
  {
    rowId: 'r2',
    key: 'shop.cancelOrder',
    operationId: 'cancelOrder',
    summary: 'Скасувати замовлення',
    kind: 'danger',
  },
];

describe('правила «Админки» (Э6-бис (б))', () => {
  it('лимит шагов по умолчанию — 10 (у «Сайта» 6), явный — как задан, мусор — режим как выключен', () => {
    expect(defaultAdminRules().maxSteps).toBe(10);
    expect(adminRulesOf(null)!.maxSteps).toBe(10);
    expect(adminRulesOf({ denyWords: ['архів'] })!.maxSteps).toBe(10);
    expect(adminRulesOf({ maxSteps: 4 })!.maxSteps).toBe(4);
    expect(parseAdminRules({ maxSteps: 16 }).ok).toBe(false);
    expect(adminRulesOf({ evil: 1 })).toBeNull();
  });

  it('поле до «Сохранить» — local; «Сохранить» — irrev и «с подтверждением»; перечень полей карточки', () => {
    const c = checkAdminPlan(
      base(
        [
          { kind: 'fill', target: 'e2', value: 'терміново', risk: 'auto' },
          { kind: 'click', target: 'e3', risk: 'auto' },
        ],
        'заповни коментар терміново і збережи',
      ),
    );
    expect(c.steps.map((s) => `${s.undo}/${s.risk}`)).toEqual([
      'local/auto',
      'irrev/confirm',
    ]);
    expect(c.pnr).toBe(1);
    expect(confirmFields(c.steps, c.pnr)).toEqual([
      { i: 0, label: 'Коментар', value: 'терміново' },
    ]);
  });

  it('серверный эффект кликом не бывает `comp`: «В кошик» — с подтверждением; поле на месте — irrev', () => {
    const site = checkPlan(
      base([{ kind: 'click', target: 'e5' }], 'натисни в кошик'),
    );
    expect(site.steps[0]).toMatchObject({ risk: 'auto', undo: 'comp' });
    const adm = checkAdminPlan(
      base([{ kind: 'click', target: 'e5' }], 'натисни в кошик'),
    );
    expect(adm.steps[0]).toMatchObject({ risk: 'confirm', undo: 'irrev' });
    const inline = checkAdminPlan(
      base(
        [{ kind: 'fill', target: 'e6', value: '59000123' }],
        'заповни трек-номер 59000123',
      ),
    );
    expect(inline.steps[0]).toMatchObject({ risk: 'confirm', undo: 'irrev' });
    expect(inline.pnr).toBe(0);
  });

  it('две точки невозврата после правил «Админки» — вторая обрезана (second_pnr)', () => {
    const c = checkAdminPlan(
      base(
        [
          { kind: 'fill', target: 'e6', value: '1' },
          { kind: 'click', target: 'e5' },
        ],
        'заповни трек-номер 1 і натисни в кошик',
      ),
    );
    expect(c.steps).toHaveLength(1);
    expect(c.notes.map((n) => n.code)).toContain('second_pnr');
  });

  it('удаление/отмена/пароль по подписи/чужая ссылка — никогда; мастер на рабочем хосте — «Сохранить» подсветкой', () => {
    for (const [target, cmd] of [
      ['e4', 'видали замовлення'],
      ['e7', 'скасуй замовлення'],
    ] as const) {
      const c = checkAdminPlan(base([{ kind: 'click', target }], cmd));
      expect(c.steps[0]).toMatchObject({ risk: 'never' });
    }
    const pw = checkAdminPlan(
      base(
        [{ kind: 'fill', target: 'e8', value: '1234' }],
        'введи пароль 1234',
      ),
    );
    expect(pw.steps).toHaveLength(0);
    const ext = checkAdminPlan(
      base([{ kind: 'click', target: 'e9' }], 'відкрий чужий сайт'),
    );
    expect(ext.steps[0]).toMatchObject({ risk: 'manual', reason: 'offhost' });
    const dry = checkAdminPlan({
      ...base(
        [
          { kind: 'fill', target: 'e2', value: 'ок' },
          { kind: 'click', target: 'e3' },
        ],
        'заповни коментар ок і збережи',
      ),
      noSubmit: true,
    });
    expect(dry.steps.map((s) => s.risk)).toEqual(['auto', 'manual']);
    expect(dry.pnr).toBeNull();
  });

  it('продолжение после перехода: те же правила для найденной цели', () => {
    const steps = checkAdminPlan(
      base([{ kind: 'fill', target: 'e2', value: 'x' }], 'заповни коментар x'),
    ).steps.map((s) => ({
      ...s,
      undo: 'comp' as const,
      risk: 'auto' as const,
    }));
    const z = adminizeResolved(steps, 0);
    expect(z.step).toMatchObject({ undo: 'irrev', risk: 'confirm' });
  });

  it('предпочтение API: изменение с операцией — api; разрушительное без операции — never; навигация — нет', () => {
    expect(
      apiPreference('зміни статус замовлення 1042 на відправлено', CATALOG),
    ).toMatchObject({ kind: 'api', op: { key: 'shop.updateOrderStatus' } });
    expect(apiPreference('скасуй замовлення 1042', CATALOG)).toMatchObject({
      kind: 'api',
      op: { key: 'shop.cancelOrder' },
    });
    expect(apiPreference('видали замовлення 1042', CATALOG)).toEqual({
      kind: 'api_any',
    });
    expect(apiPreference('видали замовлення 1042', [])).toEqual({
      kind: 'never',
    });
    // Аудит: голый глагол на кнопке — та же отмена, путь — API, не клик.
    expect(apiPreference('натисни скасувати для 1042', CATALOG)).toMatchObject({
      kind: 'api',
      op: { key: 'shop.cancelOrder' },
    });
    expect(apiPreference('повернутися до списку', CATALOG)).toBeNull();
    expect(apiPreference('відкрий замовлення 1042', CATALOG)).toBeNull();
    expect(apiPreference('знайди замовлення 1042', CATALOG)).toBeNull();
    expect(modelApiOf('{"api":"updateOrderStatus","steps":[]}')).toBe(
      'updateOrderStatus',
    );
    expect(modelApiOf('{"api":"../x y"}')).toBeNull();
  });

  it('номера строк из команды (≥ 3 цифр) — для строк таблицы в снимке', () => {
    expect(rowNumbersOf('відкрий замовлення 1042 і 77')).toEqual(['1042']);
  });

  it('мемо: шаг на странице — только без серверного эффекта', () => {
    const ui = (kind: string, target: unknown, value: unknown = null) =>
      adminMemoUiProblem({ action: 'ui', kind, target, value } as never);
    expect(
      ui('navigate', { text: 'Клієнти', role: 'link', assistId: null }),
    ).toBeNull();
    expect(
      ui('click', { text: 'Історія', role: 'tab', assistId: null }),
    ).toBeNull();
    expect(
      ui('click', { text: 'Зберегти', role: 'button', assistId: null }),
    ).toBe('click_forbidden');
    expect(
      ui('click', { text: 'Відкрити', role: 'button', assistId: null }),
    ).toBe('click_forbidden');
    expect(
      ui('navigate', {
        text: 'Видалити замовлення',
        role: 'link',
        assistId: null,
      }),
    ).toBe('click_forbidden');
    expect(
      ui(
        'fill',
        { text: 'Коментар', role: 'textbox', assistId: null },
        {
          slot: 'c',
        },
      ),
    ).toBeNull();
    expect(
      ui('fill', { text: 'Коментар', role: 'textbox', assistId: null }),
    ).toBe('value_missing');
  });

  it('мемо: отрезок шагов → сырые шаги по снимку (цель ровно одна; значение — слот)', () => {
    const c = compileAdminMemoUi(
      [
        {
          action: 'ui',
          kind: 'fill',
          target: { text: 'Коментар', role: 'textbox', assistId: null },
          value: { slot: 'note' },
        },
        {
          action: 'ui',
          kind: 'navigate',
          target: { text: 'Клієнти', role: 'link', assistId: null },
          value: null,
        },
        {
          action: 'ui',
          kind: 'click',
          target: { text: 'Історія', role: 'tab', assistId: null },
          value: null,
        },
      ],
      { note: 'терміново' },
      page(),
    );
    expect(c.missingAt).toBeNull();
    expect(c.raw).toEqual([
      { kind: 'fill', target: 'e2', value: 'терміново' },
      { kind: 'navigate', target: 'e1' },
      {
        kind: 'click',
        target: { text: 'Історія', role: 'tab', assistId: null },
      },
    ]);
    const miss = compileAdminMemoUi(
      [
        {
          action: 'ui',
          kind: 'navigate',
          target: { text: 'Немає такого', role: 'link', assistId: null },
          value: null,
        },
      ],
      {},
      page(),
    );
    expect(miss.missingAt).toBe(0);
  });

  it('мастер: запреты без звука — 100% заблокированы, у отмены есть путь API', () => {
    const r = adminForbiddenProbes({
      snapshot: page(),
      rules: defaultAdminRules(),
      hosts: [HOST],
      lang: 'uk',
      catalog: CATALOG,
      onHost: (h) => new URL(h).hostname === HOST,
    });
    expect(r.every((p) => p.blocked)).toBe(true);
    const by = Object.fromEntries(r.map((p) => [p.kind, p]));
    expect(by.delete.candidates).toBe(1);
    expect(by.cancel.api).toBe('shop.cancelOrder');
    expect(by.password.candidates).toBe(1);
    expect(by.external.candidates).toBe(1);
  });
});

describe('аудит Э6-бис (б): «Админка» строже стоп-листа «Сайта»', () => {
  // Кнопки админки, подписанные одним глаголом, и адреса удаления.
  function adminPage(): UiSnapshot {
    return parseSnapshot({
      url: `https://${HOST}/admin/orders/1042`,
      title: 'Замовлення 1042',
      elements: [
        el('e1', 'button', 'Скасувати'),
        el('e2', 'button', 'Отменить'),
        el('e3', 'button', 'Cancel'),
        el('e4', 'button', 'Повернути'),
        el('e5', 'button', 'Void'),
        el('e6', 'button', 'Move to Trash'),
        el('e7', 'link', 'Деталі', {
          href: `https://${HOST}/admin/orders/1042/delete`,
        }),
        el('e8', 'button', '', {
          assistId: 'row-7-action',
          hiddenLabel: 'Скасувати',
        }),
        el('e9', 'link', 'Скасовані', {
          href: `https://${HOST}/admin/orders/cancelled`,
        }),
        el('e10', 'link', 'Повернутися до списку', {
          href: `https://${HOST}/admin/orders`,
        }),
        el('e11', 'link', 'Return to list', {
          href: `https://${HOST}/admin/orders`,
        }),
        el('e12', 'textbox', 'Причина скасування', { inForm: true }),
        el('e13', 'button', 'Зберегти', { submit: true, inForm: true }),
      ],
    })!;
  }
  const plan = (steps: unknown[], transcript: string) =>
    checkAdminPlan({ ...base(steps, transcript), snapshot: adminPage() });

  it.each([
    ['e1', 'натисни скасувати'],
    ['e2', 'нажми отменить'],
    ['e3', 'click cancel'],
    ['e4', 'натисни повернути'],
    ['e5', 'click void'],
    ['e6', 'click move to trash'],
    ['e7', 'відкрий деталі'],
    ['e8', 'натисни скасувати'],
  ])('цель %s («%s») — никогда, 0 исполнимых шагов', (target, cmd) => {
    const c = plan([{ kind: 'click', target, risk: 'auto' }], cmd);
    expect(c.steps).toHaveLength(1);
    expect(c.steps[0]).toMatchObject({ risk: 'never', reason: 'danger' });
    expect(c.notes.map((n) => n.code)).toContain('danger');
    expect(c.needsConfirm).toBe(false);
  });

  it('не глаголы действия и поле «Причина скасування» — исполнимы', () => {
    for (const [target, cmd] of [
      ['e9', 'відкрий скасовані'],
      ['e10', 'повернутися до списку'],
      ['e11', 'return to list'],
    ] as const) {
      const c = plan([{ kind: 'click', target }], cmd);
      expect(c.steps[0].risk).not.toBe('never');
    }
    const f = plan(
      [
        { kind: 'fill', target: 'e12', value: 'дубль' },
        { kind: 'click', target: 'e13' },
      ],
      'заповни причина скасування дубль і збережи',
    );
    expect(f.steps.map((s) => s.risk)).toEqual(['auto', 'confirm']);
  });

  it('адрес с действием в пути или query — никогда; «/cancelled», «/charges» — нет', () => {
    const t = (href: string) =>
      adminNeverTarget({ text: 'Деталі', assistId: null, href });
    expect(t(`https://${HOST}/admin/orders/1042/delete`)).toBe(true);
    expect(t(`https://${HOST}/wp-admin/post.php?post=5&action=trash`)).toBe(
      true,
    );
    expect(t(`https://${HOST}/admin/refund/77`)).toBe(true);
    expect(t(`https://${HOST}/admin/orders/cancelled`)).toBe(false);
    expect(t(`https://${HOST}/admin/charges`)).toBe(false);
    expect(t(`https://${HOST}/admin/orders?status=cancelled`)).toBe(false);
  });

  it('продолжение после перехода: глагол «Скасувати» — никогда; рабочий хост мастера — «Сохранить» только подсветкой', () => {
    const resolved = (text: string, undo: 'irrev' | 'nav') =>
      [
        {
          i: 0,
          kind: 'click' as const,
          target: {
            ref: 'e1',
            text,
            role: 'button' as const,
            assistId: null,
            selector: null,
            href: null,
          },
          value: null,
          expect: null,
          risk: 'confirm' as const,
          reason: null,
          nav: false,
          say: null,
          undo,
        },
      ] as const;
    expect(
      adminizeResolved(resolved('Скасувати', 'irrev'), 0).step,
    ).toMatchObject({ risk: 'never', reason: 'danger' });
    expect(
      adminizeResolved(resolved('Зберегти', 'irrev'), 0, { noSubmit: true })
        .step,
    ).toMatchObject({ risk: 'manual', reason: 'degraded' });
    expect(
      adminizeResolved(resolved('Зберегти', 'irrev'), 0).step,
    ).toMatchObject({ risk: 'confirm' });
  });

  it('мемо: глагол «Скасувати» — click_forbidden; клик мемо по кнопке под подписью ссылки — цели нет', () => {
    expect(
      adminMemoUiProblem({
        action: 'ui',
        kind: 'navigate',
        target: { text: 'Скасувати', role: 'link', assistId: null },
        value: null,
      }),
    ).toBe('click_forbidden');
    const snap = parseSnapshot({
      url: `https://${HOST}/admin/orders/1042`,
      title: 'x',
      elements: [el('e1', 'button', 'Клієнти')],
    })!;
    const c = compileAdminMemoUi(
      [
        {
          action: 'ui',
          kind: 'navigate',
          target: { text: 'Клієнти', role: 'link', assistId: null },
          value: null,
        },
      ],
      {},
      snap,
    );
    expect(c.missingAt).toBe(0);
    expect(c.raw).toEqual([]);
  });

  it('мастер: «скасуй замовлення» находит голую «Скасувати» и она заблокирована; список кнопок «никогда»', () => {
    const r = adminForbiddenProbes({
      snapshot: adminPage(),
      rules: defaultAdminRules(),
      hosts: [HOST],
      lang: 'uk',
      catalog: [],
      onHost: (h) => new URL(h).hostname === HOST,
    });
    const by = Object.fromEntries(r.map((p) => [p.kind, p]));
    expect(by.cancel.candidates).toBeGreaterThanOrEqual(3);
    expect(by.cancel.blocked).toBe(true);
    expect(by.delete.candidates).toBeGreaterThanOrEqual(2);
    expect(by.delete.blocked).toBe(true);
    const refs = adminDangerButtons(adminPage()).map((b) => b.ref);
    expect(refs).toEqual(
      expect.arrayContaining(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8']),
    );
    expect(refs).not.toContain('e9');
  });
});

describe('билет голоса и запись «Админки»', () => {
  const key = Buffer.alloc(32, 3);
  const now = new Date('2026-10-05T10:00:00Z');
  it('билет — на этого сотрудника, этот сайт и этот текст; истекает', () => {
    const t = issueAdminVoiceTicket(key, {
      siteId: 's1',
      actor: 'jwt:a',
      text: 'відкрий клієнти',
      now,
    });
    const ok = { siteId: 's1', actor: 'jwt:a', text: 'відкрий клієнти', now };
    expect(verifyAdminVoiceTicket(key, t, ok)).toBe(true);
    expect(verifyAdminVoiceTicket(key, t, { ...ok, actor: 'jwt:b' })).toBe(
      false,
    );
    expect(verifyAdminVoiceTicket(key, t, { ...ok, siteId: 's2' })).toBe(false);
    expect(verifyAdminVoiceTicket(key, t, { ...ok, text: 'видали все' })).toBe(
      false,
    );
    expect(
      verifyAdminVoiceTicket(key, t, {
        ...ok,
        now: new Date(now.getTime() + 3 * 60_000),
      }),
    ).toBe(false);
    expect(verifyAdminVoiceTicket(null, t, ok)).toBe(false);
  });
  it('тип записи — по байтам', () => {
    expect(
      sniffAdminAudio(
        Buffer.concat([
          Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
          Buffer.alloc(20),
        ]),
      ),
    ).toBe('audio/webm');
    expect(sniffAdminAudio(Buffer.from('<html>evil</html>xx'))).toBeNull();
  });
});
