import { describeBuild } from './build-info';

/**
 * Этап 154. Версия — первое, что спрашивают у баг-репорта, и врать она
 * не имеет права ни в одну сторону.
 */
describe('describeBuild', () => {
  it('коммит Vercel обрезается до семи символов', () => {
    expect(
      describeBuild({
        VERCEL_GIT_COMMIT_SHA: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      }),
    ).toEqual({ commit: 'a1b2c3d', build: 'a1b2c3d' });
  });

  it('ручной BUILD_ID сильнее коммита', () => {
    // Иначе нестандартную сборку нечем пометить: на Vercel коммит есть
    // всегда, и он всегда побеждал бы.
    expect(
      describeBuild({
        BUILD_ID: 'hotfix-2026-09-25',
        VERCEL_GIT_COMMIT_SHA: 'a1b2c3d4e5f6',
      }),
    ).toEqual({ commit: null, build: 'hotfix-2026-09-25' });
  });

  it('без обеих переменных — «dev», а не пустота', () => {
    // Пустое поле в тикете читается как потерянное, а не как
    // неопознанная сборка.
    expect(describeBuild({})).toEqual({ commit: null, build: 'dev' });
  });

  it('мусор вместо коммита не выдаётся за версию', () => {
    // Строка «undefined» приезжает, когда переменную подставили
    // шаблоном; обрезанная до семи символов, она стала бы «undefi».
    for (const sha of ['undefined', '', '   ', 'null', 'не-хеш', 'abc']) {
      expect(describeBuild({ VERCEL_GIT_COMMIT_SHA: sha }).build).toBe('dev');
    }
  });

  it('пустой BUILD_ID не перебивает коммит', () => {
    expect(
      describeBuild({ BUILD_ID: '  ', VERCEL_GIT_COMMIT_SHA: 'a1b2c3d4e5f6' })
        .build,
    ).toBe('a1b2c3d');
  });

  it('регистр хеша приводится к нижнему — иначе одна сборка выглядит двумя', () => {
    expect(
      describeBuild({ VERCEL_GIT_COMMIT_SHA: 'A1B2C3D4E5F6' }).commit,
    ).toBe('a1b2c3d');
  });
});
