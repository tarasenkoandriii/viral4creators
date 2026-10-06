/**
 * Мемо «Админки» АМ-N — сухой прогон и «требует проверки», чистая часть
 * (аудит 06.10.2026; ТЗ §5-бис.17 п.7, п.8, п.13).
 */
import { defaultAdminRules } from '../assist-admin-voice/admin-voice-rules';
import type { UiSnapshot } from '../assist-ui-core/types';
import { parseAdminMemo, type MemoCatalogOp } from './admin-memo';
import {
  adminMemoApiChecks,
  adminMemoCheckPage,
  adminMemoCheckUsable,
  adminMemoCheckVerdict,
  adminMemoPages,
  adminMemoSameSteps,
} from './admin-memo-check';
import {
  adminMemoStats,
  decideAdminMemoReview,
  runFailure,
  type AdminMemoRunFact,
} from './admin-memo-review';

const HOST = 'admin.shop.test';
const BASE = `https://${HOST}`;
const ctx = { rules: defaultAdminRules(), hosts: [HOST] };

function el(
  ref: string,
  role: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    ref,
    role,
    tag: role === 'link' ? 'a' : role === 'textbox' ? 'input' : 'button',
    text,
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
    ...extra,
  };
}

function snap(path: string, elements: ReturnType<typeof el>[]): UiSnapshot {
  return { url: `${BASE}${path}`, title: 'Адмінка', elements } as UiSnapshot;
}

const memo = (steps: unknown[]) =>
  parseAdminMemo({
    names: { uk: 'Клієнти' },
    goal: { text: { uk: 'Відкрито' } },
    slots: [{ name: 'q', kind: 'text' }],
    steps,
  }).content;

const nav = (text: string) => ({
  action: 'ui',
  kind: 'navigate',
  target: { text, role: 'link' },
});
const fill = (text: string) => ({
  action: 'ui',
  kind: 'fill',
  target: { text, role: 'searchbox' },
  value: { slot: 'q' },
});
const apiStep = (op: string) => ({ action: 'api', op, args: {} });

const ORDERS = snap('/admin/orders', [
  el('e1', 'link', 'Клієнти', { href: `${BASE}/admin/customers` }),
  el('e2', 'button', 'Зберегти', { submit: true, inForm: true }),
]);
const CUSTOMERS = snap('/admin/customers', [
  el('e1', 'searchbox', 'Пошук клієнтів', { inputType: 'search' }),
]);

describe('adminMemoPages — отрезки шагов по страницам', () => {
  it('переход закрывает отрезок; api/say страниц не имеют', () => {
    const c = memo([
      nav('Клієнти'),
      apiStep('get'),
      fill('Пошук клієнтів'),
      { action: 'say', say: { uk: 'ok' } },
      nav('Замовлення'),
      { action: 'ui', kind: 'scroll' },
    ]);
    expect(adminMemoPages(c)).toEqual([[0], [2, 4], [5]]);
  });
});

describe('adminMemoCheckPage — страница образца по живому снимку', () => {
  const c = memo([nav('Клієнти'), fill('Пошук клієнтів')]);

  it('страница первого отрезка: ссылка найдена; цель — не здесь', () => {
    expect(adminMemoCheckPage(c, ORDERS, ctx)).toEqual({
      path: '/admin/orders',
      steps: [{ i: 0, ok: true, problem: null }],
      goal: null,
    });
  });

  it('страница последнего отрезка: поле найдено, цель ok', () => {
    expect(adminMemoCheckPage(c, CUSTOMERS, ctx)).toEqual({
      path: '/admin/customers',
      steps: [{ i: 1, ok: true, problem: null }],
      goal: 'ok',
    });
  });

  it('ни одной цели отрезка — страница отрезку не засчитана', () => {
    const r = adminMemoCheckPage(c, snap('/admin/x', []), ctx);
    expect(r.steps).toEqual([]);
    expect(r.goal).toBeNull();
  });

  it('под подписью ссылки — кнопка: шаг отрезка не найден', () => {
    const page = snap('/admin/orders', [
      el('e1', 'button', 'Клієнти'),
      el('e2', 'searchbox', 'Пошук клієнтів', { inputType: 'search' }),
    ]);
    // Один отрезок (поле, затем переход): поле есть — отрезок здесь, ссылки
    // под этой подписью нет (кнопка) — шаг не найден.
    const r = adminMemoCheckPage(
      memo([fill('Пошук клієнтів'), nav('Клієнти')]),
      page,
      ctx,
    );
    expect(r.steps).toEqual([
      { i: 0, ok: true, problem: null },
      { i: 1, ok: false, problem: 'missing' },
    ]);
    // Другой отрезок (переход «Ще» — отдельная страница) сюда не попадает.
    const two = adminMemoCheckPage(
      memo([nav('Клієнти'), nav('Ще')]),
      page,
      ctx,
    );
    expect(two.steps).toEqual([]);
  });

  it('ссылка без адреса / пункт меню-действие — irrev: «никогда»', () => {
    const noHref = snap('/admin/orders', [el('e1', 'link', 'Клієнти')]);
    expect(adminMemoCheckPage(c, noHref, ctx).steps).toEqual([
      { i: 0, ok: false, problem: 'never' },
    ]);
    const menu = memo([
      {
        action: 'ui',
        kind: 'click',
        target: { text: 'В архів', role: 'menuitem' },
      },
    ]);
    const action = snap('/admin/orders', [el('e1', 'menuitem', 'В архів')]);
    expect(adminMemoCheckPage(menu, action, ctx).steps).toEqual([
      { i: 0, ok: false, problem: 'never' },
    ]);
    const link = snap('/admin/orders', [
      el('e1', 'menuitem', 'В архів', { tag: 'a', href: `${BASE}/archive` }),
    ]);
    expect(adminMemoCheckPage(menu, link, ctx).steps).toEqual([
      { i: 0, ok: true, problem: null },
    ]);
  });

  it('две одинаковые цели — ambiguous', () => {
    const page = snap('/admin/orders', [
      el('e1', 'link', 'Клієнти', { href: `${BASE}/a` }),
      el('e2', 'link', 'Клієнти', { href: `${BASE}/b` }),
    ]);
    expect(adminMemoCheckPage(c, page, ctx).steps).toEqual([
      { i: 0, ok: false, problem: 'ambiguous' },
    ]);
  });
});

const op = (p: Partial<MemoCatalogOp> = {}): MemoCatalogOp => ({
  rowId: 'get',
  key: 'shop.getOrder',
  kind: 'read',
  enabled: true,
  unsupported: false,
  params: [],
  roles: ['orders'],
  ...p,
});

describe('adminMemoApiChecks — шаги api без вызова', () => {
  const c = memo([apiStep('get'), apiStep('gone')]);
  it('каталог, включённость, поддержка, права роли проверяющего', () => {
    const cat = new Map([['get', op()]]);
    expect(adminMemoApiChecks(c, cat, 'orders')).toEqual([
      { i: 0, op: 'shop.getOrder', kind: 'read', ok: true, problem: null },
      { i: 1, op: '', kind: null, ok: false, problem: 'operation_missing' },
    ]);
    const one = memo([apiStep('get')]);
    const p = (o: MemoCatalogOp, role: string | null) =>
      adminMemoApiChecks(one, new Map([['get', o]]), role)[0].problem;
    expect(p(op(), 'readers')).toBe('forbidden');
    expect(p(op(), null)).toBe('forbidden');
    expect(p(op(), '*')).toBeNull();
    expect(p(op({ enabled: false }), '*')).toBe('operation_disabled');
    expect(p(op({ unsupported: true }), '*')).toBe('operation_unsupported');
  });
});

describe('adminMemoCheckVerdict', () => {
  const c = memo([nav('Клієнти'), apiStep('get')]);
  const okApi = [
    {
      i: 1,
      op: 'shop.getOrder',
      kind: 'read' as const,
      ok: true,
      problem: null,
    },
  ];
  const page = adminMemoCheckPage(c, ORDERS, ctx);

  it('страница проверена, api в порядке — pass', () => {
    expect(adminMemoCheckVerdict(c, [page], okApi, 0)).toMatchObject({
      result: 'pass',
      goal: 'ok',
    });
  });
  it('страница не проверена — fail (unchecked)', () => {
    const v = adminMemoCheckVerdict(c, [], okApi, 0);
    expect(v.result).toBe('fail');
    expect(v.steps[0]).toMatchObject({ ok: false, problem: 'unchecked' });
  });
  it('api без прав — fail; фраза занята — partial', () => {
    expect(
      adminMemoCheckVerdict(
        c,
        [page],
        [{ ...okApi[0], ok: false, problem: 'forbidden' }],
        0,
      ).result,
    ).toBe('fail');
    expect(adminMemoCheckVerdict(c, [page], okApi, 1).result).toBe('partial');
  });
  it('мемо без шагов на странице — проверять на странице нечего', () => {
    const a = memo([apiStep('get')]);
    expect(
      adminMemoCheckVerdict(a, [], [{ ...okApi[0], i: 0 }], 0),
    ).toMatchObject({ result: 'pass', goal: 'ok' });
  });
  it('отчёт годен только для той же версии (хеш) и pass/partial', () => {
    const r = { kind: 'memo-check', contentHash: 'h1', result: 'pass' };
    expect(adminMemoCheckUsable(r, 'h1')).toBe(true);
    expect(adminMemoCheckUsable(r, 'h2')).toBe(false);
    expect(adminMemoCheckUsable({ ...r, result: 'partial' }, 'h1')).toBe(true);
    expect(adminMemoCheckUsable({ ...r, result: 'fail' }, 'h1')).toBe(false);
    expect(adminMemoCheckUsable({ ...r, kind: 'x' }, 'h1')).toBe(false);
    expect(adminMemoCheckUsable({ result: 'pass' }, 'h1')).toBe(false);
    expect(adminMemoCheckUsable(null, 'h1')).toBe(false);
  });
  it('перенос отчёта — только если шаги и слоты те же', () => {
    const b = memo([nav('Клієнти'), apiStep('get')]);
    expect(
      adminMemoSameSteps(c, { ...b, names: { uk: 'інше' } } as never),
    ).toBe(true);
    expect(adminMemoSameSteps(c, memo([nav('Клієнти')]))).toBe(false);
  });
});

const run = (
  actor: string,
  p: Partial<AdminMemoRunFact> & { outcome?: string } = {},
): AdminMemoRunFact => ({
  actor,
  status: p.status ?? 'failed',
  step: p.step ?? 0,
  goalStatus: p.goalStatus === undefined ? 'not_reached' : p.goalStatus,
  progress: p.outcome
    ? [{ i: p.step ?? 0, operation: 'x', outcome: p.outcome }]
    : (p.progress ?? []),
  createdAt: p.createdAt ?? new Date('2026-10-06T10:00:00Z'),
});
const NOW = new Date('2026-10-06T12:00:00Z');

describe('decideAdminMemoReview — пороги §5-бис.17 п.8', () => {
  it('сбой на шаге у 3 разных сотрудников — да; у 2 или 3 раза одного — нет', () => {
    expect(
      decideAdminMemoReview([run('a'), run('b'), run('b'), run('b')], 1, NOW),
    ).toBeNull();
    expect(
      decideAdminMemoReview([run('a'), run('b'), run('c')], 1, NOW),
    ).toEqual({
      code: 'failures',
      step: 1,
      version: 1,
      employees: 3,
      at: NOW.toISOString(),
    });
  });
  it('сбои на РАЗНЫХ шагах не складываются', () => {
    expect(
      decideAdminMemoReview(
        [run('a'), run('b', { step: 1 }), run('c', { step: 2 })],
        1,
        NOW,
      ),
    ).toBeNull();
  });
  it('pinMismatch — своя причина; «нет страницы», «Нет» сотрудника — не сбой', () => {
    expect(
      decideAdminMemoReview(
        ['a', 'b', 'c'].map((x) => run(x, { outcome: 'pin_mismatch' })),
        2,
        NOW,
      ),
    ).toMatchObject({ code: 'pin_mismatch', step: 1, version: 2 });
    expect(
      decideAdminMemoReview(
        [
          run('a'),
          run('b'),
          run('c', { outcome: 'needs_page' }),
          run('d', { status: 'stopped' }),
          run('e', { status: 'expired' }),
        ],
        1,
        NOW,
      ),
    ).toBeNull();
    expect(runFailure(run('x', { outcome: 'needs_page' }))).toBeNull();
    expect(runFailure(run('x', { status: 'done' }))).toBeNull();
  });
  it('цель < 60% на ≥ 10 запусках', () => {
    const ok = (n: number) =>
      Array.from({ length: n }, () =>
        run('s', { status: 'done', goalStatus: 'reached' }),
      );
    const bad = (n: number) =>
      Array.from({ length: n }, () =>
        run('s', { status: 'stopped', goalStatus: 'not_reached' }),
      );
    expect(decideAdminMemoReview(bad(9), 1, NOW)).toBeNull();
    expect(decideAdminMemoReview(bad(10), 1, NOW)).toMatchObject({
      code: 'goal_low',
      runs: 10,
      reached: 0,
    });
    expect(decideAdminMemoReview([...ok(6), ...bad(4)], 1, NOW)).toBeNull();
    expect(decideAdminMemoReview([...ok(5), ...bad(5)], 1, NOW)).toMatchObject({
      code: 'goal_low',
      runs: 10,
      reached: 5,
    });
    // Запуски без итога цели — не в доле.
    expect(
      decideAdminMemoReview(
        [
          ...ok(6),
          ...bad(3),
          run('s', { status: 'expired', goalStatus: null }),
        ],
        1,
        NOW,
      ),
    ).toBeNull();
  });
});

describe('adminMemoStats — статистика для TMA (§5-бис.17 п.13)', () => {
  it('запуски, цель, сбои по шагам (номер с 1), сотрудники', () => {
    const s = adminMemoStats(
      [
        run('a', { status: 'done', goalStatus: 'reached' }),
        run('a', { step: 1, outcome: 'pin_mismatch' }),
        run('b', { step: 1 }),
        run('c', { status: 'stopped' }),
        run('d', {
          outcome: 'needs_page',
          createdAt: new Date('2026-10-06T11:00:00Z'),
        }),
      ],
      30,
    );
    expect(s).toEqual({
      days: 30,
      runs: 5,
      reached: 1,
      notReached: 3,
      unknown: 0,
      failed: 2,
      stopped: 1,
      pinMismatch: 1,
      employees: 4,
      goalRate: 0.25,
      lastRunAt: '2026-10-06T11:00:00.000Z',
      failures: [{ step: 2, n: 2, employees: 2, pin: true }],
    });
    expect(adminMemoStats([], 7)).toMatchObject({
      runs: 0,
      goalRate: null,
      lastRunAt: null,
      failures: [],
    });
  });
});
