/**
 * Ссылки на учётку реестра в полях входа черновика и тело запроса входа
 * учёткой реестра (Э-С Ш2-хвост (3)).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegistryLoginRequestDto } from './dto/client-site-tutorial.dto';
import {
  LoginFieldsNotFoundError,
  REGISTRY_REF_PREFIX,
  looksLikeRegistryRef,
  parseRegistryRef,
  registryRef,
} from './registry-login';

describe('ссылка на учётку реестра', () => {
  it('туда и обратно; кривая — null, но «похожа» (из ввода не принимается)', () => {
    const ref = registryRef('ta_1-x', 'password');
    expect(ref.startsWith(REGISTRY_REF_PREFIX)).toBe(true);
    expect(parseRegistryRef(ref)).toEqual({
      testAccountId: 'ta_1-x',
      part: 'password',
    });
    expect(parseRegistryRef(registryRef('a', 'username'))).toEqual({
      testAccountId: 'a',
      part: 'username',
    });
    for (const bad of [
      `${REGISTRY_REF_PREFIX}../x:password`,
      `${REGISTRY_REF_PREFIX}a:totp`,
      `${REGISTRY_REF_PREFIX}a:password:x`,
    ]) {
      expect(parseRegistryRef(bad)).toBeNull();
      expect(looksLikeRegistryRef(bad)).toBe(true);
    }
    // Обычное значение, даже со словом registry, — не ссылка.
    expect(looksLikeRegistryRef('registry:a:password')).toBe(false);
  });

  it('отказ «не нашли поля входа» — 422 с кодом и перечнем, без значений', () => {
    const e = new LoginFieldsNotFoundError(['username', 'submit']);
    expect(e.getStatus()).toBe(422);
    expect(e.getResponse()).toMatchObject({
      error: 'LOGIN_FIELDS_NOT_FOUND',
      code: 'LOGIN_FIELDS_NOT_FOUND',
      reason: 'username,submit',
    });
  });
});

describe('RegistryLoginRequestDto', () => {
  const check = (body: unknown) =>
    validate(plainToInstance(RegistryLoginRequestDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('годное тело: версия и id учётки; поля — по желанию', async () => {
    expect(await check({ expectedVersion: 3, testAccountId: 'ta1' })).toEqual(
      [],
    );
    expect(
      await check({
        expectedVersion: 0,
        testAccountId: 'ta1',
        forgetAfterBuild: true,
        pick: { passwordSelector: '#pw', submitSelector: '#go' },
      }),
    ).toEqual([]);
  });

  it('секретов в теле нет и быть не может; кривой id и лишнее в pick — 400', async () => {
    expect(
      await check({ expectedVersion: 3, testAccountId: 'ta1', password: 'x' }),
    ).not.toEqual([]);
    expect(
      await check({ expectedVersion: 3, testAccountId: '../ta1' }),
    ).not.toEqual([]);
    expect(
      await check({
        expectedVersion: 3,
        testAccountId: 'ta1',
        pick: { passwordSelector: '#pw', value: 'x' },
      }),
    ).not.toEqual([]);
    expect(
      await check({
        expectedVersion: 3,
        testAccountId: 'ta1',
        pick: { passwordSelector: '' },
      }),
    ).not.toEqual([]);
  });
});
