/**
 * Э6-тер (к): шаги обучалки → черновик мемо (чистая часть) и строгий клиент
 * генератора (подпись, разбор, отказы).
 */
import {
  SITES_CALLER_MEMO,
  SITES_CALLER_TUTORIAL,
  verifySitesRequest,
} from '../../../shared/sites-internal-signature';
import { defaultVoiceControlRules } from '../../assist-ui-core/rules';
import { memoGates } from '../../assist-ui-core/memo';
import {
  GeneratorMemoStepsClient,
  GeneratorNotConfiguredError,
  GeneratorRefusedError,
  GeneratorUnavailableError,
  generatorOrigin,
  parseTutorialMemoSteps,
  type TutorialMemoSteps,
} from './generator-memo-steps.client';
import {
  findTutorialElement,
  memoFromTutorial,
  type TutorialUiElement,
} from './memo-from-tutorial';

const el = (
  over: Partial<TutorialUiElement> & Pick<TutorialUiElement, 'selector'>,
): TutorialUiElement => ({
  id: `row_${(over.selector ?? '').replace(/[^A-Za-z0-9]/g, '')}`,
  path: '/catalog',
  viewport: 'mobile',
  elementKey: `c:${over.selector}`,
  tag: 'button',
  label: 'Кнопка',
  role: null,
  candidates: [],
  stability: 'medium',
  ...over,
});

const MAP: TutorialUiElement[] = [
  el({ selector: '#add', label: 'В кошик' }),
  el({
    selector: '#add',
    label: 'В кошик (десктоп)',
    viewport: 'desktop',
    id: 'row_desktop',
  }),
  el({
    selector: 'a.cart',
    tag: 'a',
    label: 'Кошик',
    candidates: [
      { kind: 'assist-id', selector: '[data-assist-id="nav-cart"]' },
    ],
  }),
  el({ selector: '#email', tag: 'input', label: 'E-mail', path: '/cart' }),
  el({ selector: '#buy', label: 'Оформити', path: '/cart' }),
];

const src = (
  steps: TutorialMemoSteps['steps'],
  over: Partial<TutorialMemoSteps> = {},
): TutorialMemoSteps => ({
  draftId: 'dr',
  siteId: 'site',
  title: 'Покласти в кошик',
  host: 'shop.example.com',
  startPath: '/catalog',
  endPath: '/cart',
  view: 'mobile',
  requiresLogin: false,
  steps,
  dropped: { login: 0, foreign: 0, other: 0 },
  ...over,
});

describe('memoFromTutorial', () => {
  it('клик — по элементу Ш4 (вид съёмки), ссылка с переходом — href, fill — слот без значения, цель — адрес', () => {
    const r = memoFromTutorial(
      src([
        { kind: 'navigate', path: '/catalog' },
        { kind: 'click', selector: '#add' },
        { kind: 'click', selector: 'a.cart' },
        { kind: 'fill', selector: '#email', field: 'email' },
      ]),
      MAP,
      'uk',
    );
    const c = r.content;
    expect(r.unresolved).toEqual([]);
    expect(c.view).toBe('mobile');
    expect(c.names.uk).toBe('Покласти в кошик');
    expect(c.goal.text.uk).toBe('Покласти в кошик');
    expect(
      c.steps.map((s) => [s.page, s.action, s.target?.uiElementId]),
    ).toEqual([
      ['/catalog', 'click', 'row_add'],
      ['/catalog', 'click', 'row_acart'],
      ['/cart', 'fill', 'row_email'],
    ]);
    expect(c.steps[1].target?.pin).toMatchObject({
      tag: 'a',
      role: 'link',
      assistId: 'nav-cart',
      href: '/cart',
    });
    expect(c.steps[2].value).toEqual({ slot: 'email' });
    expect(c.steps[2].target?.pin).toMatchObject({
      pd: true,
      inputType: 'email',
    });
    expect(c.slots).toEqual([
      { name: 'email', kind: 'email', pii: true, options: [] },
    ]);
    expect(c.goal.expect).toEqual([{ kind: 'url', path: '/cart' }]);
    // Те же ворота, что у сборки версии: целей и значений хватает.
    const g = memoGates(c, {
      rules: defaultVoiceControlRules(),
      host: 'shop.example.com',
    });
    expect(g.problems.map((p) => p.code)).not.toContain('no_target');
    expect(g.problems.map((p) => p.code)).not.toContain('value_not_slot');
    expect(g.problems.map((p) => p.code)).not.toContain('no_goal');
  });

  it('элемента нет в карте — шаг без цели (ворота no_target), номер — в отчёте', () => {
    const r = memoFromTutorial(
      src([
        { kind: 'click', selector: '#nowhere' },
        { kind: 'click', selector: '#add' },
      ]),
      MAP,
      'ru',
    );
    expect(r.unresolved).toEqual([0]);
    expect(r.content.steps[0]).toMatchObject({
      page: '/catalog',
      target: null,
    });
    const g = memoGates(r.content, {
      rules: defaultVoiceControlRules(),
      host: 'shop.example.com',
    });
    expect(g.ok).toBe(false);
    expect(g.problems).toContainEqual({
      code: 'no_target',
      path: 'steps[0].target',
    });
  });

  it('больше 5 полей — 5 слотов, остальные без значения (ворота value_not_slot)', () => {
    const r = memoFromTutorial(
      src(
        Array.from({ length: 7 }, () => ({
          kind: 'fill' as const,
          selector: '#email',
          field: 'text' as const,
        })),
      ),
      MAP,
      'uk',
    );
    expect(r.content.slots.map((s) => s.name)).toEqual([
      'text',
      'text_2',
      'text_3',
      'text_4',
      'text_5',
    ]);
    expect(r.slotsOverflow).toBe(2);
    expect(r.content.steps[6].value).toBeNull();
  });

  it('название с ПД/адресом — шаблонное имя, без описания цели', () => {
    const r = memoFromTutorial(
      src([{ kind: 'click', selector: '#add' }], {
        title: 'Пишіть на boss@shop.ua',
      }),
      MAP,
      'en',
    );
    expect(r.content.names.en).toBe('Memo from tutorial');
    expect(r.content.goal.text.en).toBeUndefined();
    expect(JSON.stringify(r.content)).not.toContain('boss@shop.ua');
  });

  it('поиск элемента: текущая страница важнее, вид съёмки важнее', () => {
    expect(findTutorialElement(MAP, '#add', '/catalog', 'mobile')?.id).toBe(
      'row_add',
    );
    expect(findTutorialElement(MAP, '#add', '/catalog', 'desktop')?.id).toBe(
      'row_desktop',
    );
    expect(findTutorialElement(MAP, '#nope', null, 'mobile')).toBeNull();
  });
});

const OK = {
  draftId: 'dr',
  siteId: 'site',
  title: 'T',
  host: 'shop.example.com',
  startPath: '/a',
  endPath: null,
  view: 'mobile',
  requiresLogin: true,
  steps: [
    { kind: 'navigate', path: '/a' },
    { kind: 'click', selector: '#b' },
    { kind: 'fill', selector: '#c', field: 'phone' },
  ],
  dropped: { login: 3, foreign: 0, other: 0 },
};

describe('parseTutorialMemoSteps — строгий разбор ответа генератора', () => {
  const exp = { siteId: 'site', draftId: 'dr' };
  it('годный ответ', () => {
    expect(parseTutorialMemoSteps(OK, exp)).toMatchObject({
      requiresLogin: true,
      steps: OK.steps,
      dropped: { login: 3, foreign: 0, other: 0 },
    });
  });
  it.each([
    ['чужой сайт в ответе', { ...OK, siteId: 'other' }],
    ['чужой черновик в ответе', { ...OK, draftId: 'x' }],
    [
      'значение у fill',
      {
        ...OK,
        steps: [
          { kind: 'fill', selector: '#c', field: 'text', value: 'secret' },
        ],
      },
    ],
    [
      'пароль-тип поля',
      { ...OK, steps: [{ kind: 'fill', selector: '#c', field: 'password' }] },
    ],
    [
      'неизвестный шаг',
      { ...OK, steps: [{ kind: 'goto', route: 'https://x/' }] },
    ],
    [
      'адрес вместо пути',
      { ...OK, steps: [{ kind: 'navigate', path: 'https://evil/' }] },
    ],
    ['вид', { ...OK, view: 'tv' }],
    ['хост', { ...OK, host: 'Evil Host' }],
    [
      'слишком много шагов',
      { ...OK, steps: Array(31).fill({ kind: 'click', selector: '#b' }) },
    ],
  ])('%s — отказ', (_n, raw) => {
    expect(parseTutorialMemoSteps(raw, exp)).toBeNull();
  });
});

describe('GeneratorMemoStepsClient', () => {
  const SECRET = 'k'.repeat(40);
  function client(
    reply: (path: string) => { status: number; body: unknown },
    env: NodeJS.ProcessEnv = {
      GENERATOR_INTERNAL_URL: 'https://gen.example.com/',
      SITES_TUTORIAL_HMAC_SECRET: SECRET,
    },
  ) {
    const c = new GeneratorMemoStepsClient();
    c.env = env;
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    c.fetchImpl = async (input, init) => {
      seen.push({ url: String(input), init });
      const r = reply(new URL(String(input)).pathname);
      return new Response(JSON.stringify(r.body), { status: r.status });
    };
    return { c, seen };
  }

  it('подпись: GET без тела, вызывающий sites-memo, путь с id; подпись генератора-направления не подходит', async () => {
    const { c, seen } = client(() => ({
      status: 200,
      body: { success: true, data: OK },
    }));
    await expect(c.memoSteps('site', 'dr')).resolves.toMatchObject({
      siteId: 'site',
    });
    const { url, init } = seen[0];
    expect(url).toBe(
      'https://gen.example.com/api/internal/client-site-tutorial/memo-steps/site/dr',
    );
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    const headers = init?.headers as Record<string, string>;
    const check = (caller: string) =>
      verifySitesRequest(SECRET, {
        method: 'GET',
        path: new URL(url).pathname,
        body: '',
        headers,
        nowSeconds: Math.floor(Date.now() / 1000),
        expectedCaller: caller,
      });
    expect(check(SITES_CALLER_MEMO).ok).toBe(true);
    expect(check(SITES_CALLER_TUTORIAL)).toEqual({
      ok: false,
      reason: 'caller',
    });
    expect(JSON.stringify(headers)).not.toContain(SECRET);
  });

  it('не настроен — не ходит в сеть; http-адрес не принимается', async () => {
    const { c, seen } = client(() => ({ status: 200, body: {} }), {});
    expect(c.configured()).toBe(false);
    await expect(c.memoSteps('site', 'dr')).rejects.toBeInstanceOf(
      GeneratorNotConfiguredError,
    );
    expect(seen).toEqual([]);
    expect(
      generatorOrigin({ GENERATOR_INTERNAL_URL: 'http://gen.example.com' }),
    ).toBeNull();
    expect(
      generatorOrigin({ GENERATOR_INTERNAL_URL: 'http://localhost:3000' }),
    ).toBe('http://localhost:3000');
  });

  it('404/422 — отказ с причиной; 401/500/мусор — недоступен', async () => {
    const refuse = (status: number, reason?: string) =>
      client(() => ({
        status,
        body: {
          success: false,
          error: { code: 'X', details: reason ? { reason } : {} },
        },
      })).c.memoSteps('site', 'dr');
    await expect(refuse(404)).rejects.toMatchObject({ status: 404 });
    await expect(refuse(422, 'mode_b')).rejects.toEqual(
      new GeneratorRefusedError(422, 'mode_b'),
    );
    await expect(refuse(401)).rejects.toBeInstanceOf(GeneratorUnavailableError);
    await expect(refuse(500)).rejects.toBeInstanceOf(GeneratorUnavailableError);
    await expect(
      client(() => ({
        status: 200,
        body: { success: true, data: { ...OK, siteId: 'x' } },
      })).c.memoSteps('site', 'dr'),
    ).rejects.toBeInstanceOf(GeneratorUnavailableError);
  });
});
