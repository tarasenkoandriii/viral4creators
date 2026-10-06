/**
 * Э6-тер (к): что из черновика обучалки уходит в черновик мемо помощника и
 * чего не уходит никогда (значения полей, вход, чужой сайт, режим B).
 */
import {
  exportMemoSteps,
  fieldKindOf,
  isLoginRound,
  type MemoExportDraft,
} from './memo-steps-export';

const SITE = 'site_1';

function draft(over: Partial<MemoExportDraft> = {}): MemoExportDraft {
  return {
    id: 'dr_1',
    status: 'APPROVED',
    siteMode: 'A',
    clientSiteId: SITE,
    baseUrl: 'https://shop.example.com',
    lastUrl: 'https://shop.example.com/cart?token=SECRET#x',
    title: '  Покласти   в кошик ',
    steps: [
      { kind: 'goto', route: 'https://shop.example.com/catalog?utm=1' },
      { kind: 'click', selector: '#add-to-cart' },
      { kind: 'fill', selector: 'input[name="email"]', value: 'me@mail.ua' },
      { kind: 'click', selector: 'a[href="/cart"]' },
    ],
    stepsPerRound: [1, 1, 2],
    loginUsedAt: null,
    credentialsEnc: null,
    requiresLiveLoginReplay: false,
    storeHasCredentials: false,
    ...over,
  };
}

describe('exportMemoSteps', () => {
  it('режим A, свой сайт: goto → navigate (путь без query), click, fill → вид поля без значения', () => {
    const r = exportMemoSteps(draft(), SITE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.steps).toEqual([
      { kind: 'navigate', path: '/catalog' },
      { kind: 'click', selector: '#add-to-cart' },
      { kind: 'fill', selector: 'input[name="email"]', field: 'email' },
      { kind: 'click', selector: 'a[href="/cart"]' },
    ]);
    expect(r.value.startPath).toBe('/catalog');
    expect(r.value.endPath).toBe('/cart');
    expect(r.value.host).toBe('shop.example.com');
    expect(r.value.view).toBe('mobile');
    expect(r.value.requiresLogin).toBe(false);
    expect(r.value.title).toBe('Покласти в кошик');
    // Значение поля и query-токен не уходят нигде в ответе.
    const json = JSON.stringify(r.value);
    expect(json).not.toContain('me@mail.ua');
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('utm');
  });

  it('чужой сайт и черновик без привязки — как несуществующий', () => {
    expect(exportMemoSteps(draft(), 'site_other')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(exportMemoSteps(draft({ clientSiteId: null }), SITE)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(exportMemoSteps(null, SITE)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('режим B и черновик до Ш1 (siteMode null) — не источник', () => {
    expect(exportMemoSteps(draft({ siteMode: 'B' }), SITE)).toEqual({
      ok: false,
      reason: 'mode_b',
    });
    expect(exportMemoSteps(draft({ siteMode: null }), SITE)).toEqual({
      ok: false,
      reason: 'mode_b',
    });
  });

  it('только одобренные', () => {
    for (const status of ['DRAFTING', 'PENDING_REVIEW', 'REJECTED'])
      expect(exportMemoSteps(draft({ status }), SITE)).toEqual({
        ok: false,
        reason: 'not_approved',
      });
  });

  it('вход /login (секретное поле без значения) и всё до него — отброшены; мемо — закрытая зона', () => {
    const r = exportMemoSteps(
      draft({
        steps: [
          { kind: 'goto', route: 'https://shop.example.com/login' },
          // экран 1: e-mail (не секретный, со значением)
          { kind: 'fill', selector: '#login-email', value: 'boss@shop.ua' },
          { kind: 'click', selector: '#next' },
          // экран 2: пароль — секретное поле без значения
          { kind: 'fill', selector: '#pw', value: '' },
          { kind: 'click', selector: '#submit' },
          // закрытая зона
          { kind: 'click', selector: '#orders' },
          { kind: 'fill', selector: '#search', value: 'замовлення 42' },
        ],
        stepsPerRound: [1, 2, 2, 1, 1],
        loginUsedAt: new Date(),
      }),
      SITE,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.steps).toEqual([
      { kind: 'click', selector: '#orders' },
      { kind: 'fill', selector: '#search', field: 'text' },
    ]);
    expect(r.value.startPath).toBeNull();
    expect(r.value.requiresLogin).toBe(true);
    expect(r.value.dropped.login).toBe(5);
    const json = JSON.stringify(r.value);
    for (const leak of [
      'boss@shop.ua',
      '#pw',
      '#login-email',
      '#submit',
      'замовлення',
    ])
      expect(json).not.toContain(leak);
  });

  it('ввод в поле пароля/кода через /step — тоже вход; маркер живого входа — тоже', () => {
    const viaStep = exportMemoSteps(
      draft({
        steps: [
          { kind: 'goto', route: 'https://shop.example.com/' },
          { kind: 'fill', selector: 'input[name="otp-code"]', value: '123456' },
          { kind: 'click', selector: '#ok' },
          { kind: 'click', selector: '#profile' },
        ],
        stepsPerRound: [1, 2, 1],
      }),
      SITE,
    );
    expect(viaStep.ok && viaStep.value.steps).toEqual([
      { kind: 'click', selector: '#profile' },
    ]);
    expect(JSON.stringify(viaStep)).not.toContain('123456');

    const live = exportMemoSteps(
      draft({
        steps: [
          { kind: 'goto', route: 'https://shop.example.com/' },
          { kind: 'assertVisible', selector: '#cabinet' },
          { kind: 'click', selector: '#orders' },
        ],
        stepsPerRound: [1, 1, 1],
        requiresLiveLoginReplay: true,
      }),
      SITE,
    );
    expect(live.ok && live.value.steps).toEqual([
      { kind: 'click', selector: '#orders' },
    ]);
    expect(live.ok && live.value.requiresLogin).toBe(true);
  });

  it('рассогласованные раунды — каждый шаг сам по себе (вход всё равно отброшен)', () => {
    const r = exportMemoSteps(
      draft({
        steps: [
          { kind: 'goto', route: 'https://shop.example.com/' },
          { kind: 'fill', selector: '#user', value: 'u' },
          { kind: 'fill', selector: '#password', value: '' },
          { kind: 'click', selector: '#go' },
        ],
        stepsPerRound: [1, 9],
      }),
      SITE,
    );
    expect(r.ok && r.value.steps).toEqual([{ kind: 'click', selector: '#go' }]);
  });

  it('проверки, платные маркеры и адреса другого хоста — не шаги мемо', () => {
    const r = exportMemoSteps(
      draft({
        steps: [
          { kind: 'goto', route: 'https://evil.example.org/x' },
          { kind: 'waitFor', selector: '#a' },
          { kind: 'assertText', selector: '#a', value: 'Ціна 100' },
          { kind: 'triggerPaidOperation', operation: 'generation' },
          { kind: 'click', selector: '#buy' },
        ],
        stepsPerRound: [1, 1, 1, 1, 1],
      }),
      SITE,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.steps).toEqual([{ kind: 'click', selector: '#buy' }]);
    expect(r.value.dropped).toEqual({ login: 0, foreign: 1, other: 3 });
    expect(JSON.stringify(r.value)).not.toContain('Ціна');
  });

  it('без действий после входа — no_steps', () => {
    expect(
      exportMemoSteps(
        draft({
          steps: [
            { kind: 'goto', route: 'https://shop.example.com/' },
            { kind: 'fill', selector: '#pw', value: '' },
            { kind: 'click', selector: '#go' },
          ],
          stepsPerRound: [1, 2],
        }),
        SITE,
      ),
    ).toEqual({ ok: false, reason: 'no_steps' });
  });
});

describe('fieldKindOf / isLoginRound', () => {
  it('вид поля — по селектору', () => {
    expect(fieldKindOf('input[type="email"]')).toBe('email');
    expect(fieldKindOf('#phone')).toBe('phone');
    expect(fieldKindOf('input[name="qty"]')).toBe('number');
    expect(fieldKindOf('#q')).toBe('text');
  });
  it('раунд входа', () => {
    expect(isLoginRound([{ kind: 'fill', selector: '#a', value: '' }])).toBe(
      true,
    );
    expect(isLoginRound([{ kind: 'fill', selector: '#a', value: 'x' }])).toBe(
      false,
    );
    expect(isLoginRound([{ kind: 'assertVisible', selector: '#a' }])).toBe(
      true,
    );
    expect(
      isLoginRound([
        { kind: 'assertVisible', selector: '#a' },
        { kind: 'click', selector: '#b' },
      ]),
    ).toBe(false);
  });
});
