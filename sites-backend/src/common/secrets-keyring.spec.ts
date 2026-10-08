/**
 * Общая связка `ASSIST_SECRETS_KEY` (№60, Р-З10-12): разбор env, формула
 * производного ключа (ключ `v1` побайтно прежний), префикс версии,
 * порядок ключей при чтении, проверка HMAC списком.
 */
import { createHmac } from 'crypto';
import {
  AdminSecretsError,
  loadAdminKeyring,
} from '../modules/assist-admin-mode/admin-secrets-crypto';
import { liveKeysFrom } from '../modules/assist-site-voice-control/public/live-crypto';
import {
  derivedKeys,
  deriveSecretKey,
  hmacKeyList,
  openWithKeys,
  parseSecretsKeyring,
  secretsKeyringProblems,
  splitKeyVersion,
} from './secrets-keyring';

const legacy = (secret: string, label: string) =>
  createHmac('sha256', secret).update(label).digest();

describe('parseSecretsKeyring', () => {
  it('нет ключа — связки нет, ошибки нет', () => {
    expect(parseSecretsKeyring({})).toEqual({ keyring: null, problem: null });
    expect(
      parseSecretsKeyring({ ASSIST_SECRETS_KEY: '  ' }).keyring,
    ).toBeNull();
  });

  it('только ключ — версия v1; пробелы срезаются', () => {
    const { keyring, problem } = parseSecretsKeyring({
      ASSIST_SECRETS_KEY: ' k1 ',
    });
    expect(problem).toBeNull();
    expect(keyring?.current).toBe('v1');
    expect(keyring?.versions).toEqual(['v1']);
    expect(keyring?.secret('v1')).toBe('k1');
    expect(keyring?.secret('v2')).toBeNull();
  });

  it('текущий + прежние — текущий первым, прежние по порядку env', () => {
    const { keyring } = parseSecretsKeyring({
      ASSIST_SECRETS_KEY: 'k3',
      ASSIST_SECRETS_KEY_VERSION: 'v3',
      ASSIST_SECRETS_KEYS_OLD: ' v2:k2 , v1:k1:with:colons ,',
    });
    expect(keyring?.versions).toEqual(['v3', 'v2', 'v1']);
    expect(keyring?.secret('v1')).toBe('k1:with:colons');
  });

  it('кривая версия — ключ считается v1, прежние не берутся, ошибка видна', () => {
    const env = {
      ASSIST_SECRETS_KEY: 'k1',
      ASSIST_SECRETS_KEY_VERSION: 'second',
      ASSIST_SECRETS_KEYS_OLD: 'v1:k0',
    };
    const { keyring, problem } = parseSecretsKeyring(env);
    expect(problem).toBe('invalid_version');
    expect(keyring?.versions).toEqual(['v1']);
    expect(keyring?.secret('v1')).toBe('k1');
    expect(secretsKeyringProblems(env)[0]).toMatch(
      /ASSIST_SECRETS_KEY_VERSION/,
    );
    expect(secretsKeyringProblems(env).join()).not.toMatch(/k0|k1/);
  });

  it.each([
    ['без двоеточия', 'v1k1'],
    ['пустой ключ', 'v1:'],
    ['кривая версия', 'x1:k1'],
    ['повтор', 'v1:a,v1:b'],
    ['версия текущего', 'v2:a'],
  ])('кривой список прежних (%s) — только текущий ключ', (_n, old) => {
    const env = {
      ASSIST_SECRETS_KEY: 'k2',
      ASSIST_SECRETS_KEY_VERSION: 'v2',
      ASSIST_SECRETS_KEYS_OLD: old,
    };
    const { keyring, problem } = parseSecretsKeyring(env);
    expect(problem).toBe('invalid_old');
    expect(keyring?.versions).toEqual(['v2']);
    expect(secretsKeyringProblems(env)[0]).toMatch(/ASSIST_SECRETS_KEYS_OLD/);
  });

  it('тот же формат env, что у «Админки» и liveValues: принимают и отвергают одно и то же', () => {
    const cases: NodeJS.ProcessEnv[] = [
      { ASSIST_SECRETS_KEY: 'k' },
      {
        ASSIST_SECRETS_KEY: 'k',
        ASSIST_SECRETS_KEY_VERSION: 'v2',
        ASSIST_SECRETS_KEYS_OLD: 'v1:a',
      },
      { ASSIST_SECRETS_KEY: 'k', ASSIST_SECRETS_KEY_VERSION: 'v0' },
      { ASSIST_SECRETS_KEY: 'k', ASSIST_SECRETS_KEY_VERSION: 'v10000' },
      { ASSIST_SECRETS_KEY: 'k', ASSIST_SECRETS_KEYS_OLD: 'v1:a' },
      { ASSIST_SECRETS_KEY: 'k', ASSIST_SECRETS_KEYS_OLD: 'v2:a,v3:' },
      { ASSIST_SECRETS_KEY: 'k', ASSIST_SECRETS_KEYS_OLD: ',,v2:a,,' },
    ];
    for (const env of cases) {
      const mine = parseSecretsKeyring(env).problem === null;
      let admin: boolean | string = true;
      try {
        loadAdminKeyring(env);
      } catch (e) {
        admin = e instanceof AdminSecretsError ? false : String(e);
      }
      let live = true;
      try {
        liveKeysFrom(env);
      } catch {
        live = false;
      }
      expect([env, mine]).toEqual([env, admin]);
      expect([env, mine]).toEqual([env, live]);
    }
  });
});

describe('derivedKeys', () => {
  it('ключ v1 — побайтно прежняя формула HMAC(ASSIST_SECRETS_KEY, метка)', () => {
    const k = derivedKeys({ ASSIST_SECRETS_KEY: ' s1 ' }, 'label-x');
    expect(k?.current).toBe('v1');
    expect(k?.currentKey.equals(legacy('s1', 'label-x'))).toBe(true);
    expect(
      deriveSecretKey(' s1 ', 'label-x').equals(legacy('s1', 'label-x')),
    ).toBe(true);
  });

  it('все версии; метки разных потребителей не дают общих байтов', () => {
    const env = {
      ASSIST_SECRETS_KEY: 's2',
      ASSIST_SECRETS_KEY_VERSION: 'v2',
      ASSIST_SECRETS_KEYS_OLD: 'v1:s1',
    };
    const a = derivedKeys(env, 'a')!;
    const b = derivedKeys(env, 'b')!;
    expect(a.versions).toEqual(['v2', 'v1']);
    expect(a.all.map((x) => x.toString('hex'))).toEqual([
      legacy('s2', 'a').toString('hex'),
      legacy('s1', 'a').toString('hex'),
    ]);
    expect(a.key('v1')?.equals(b.key('v1')!)).toBe(false);
    expect(a.key('v9')).toBeNull();
    expect(derivedKeys({}, 'a')).toBeNull();
  });
});

describe('префикс версии и openWithKeys', () => {
  const env = {
    ASSIST_SECRETS_KEY: 's3',
    ASSIST_SECRETS_KEY_VERSION: 'v3',
    ASSIST_SECRETS_KEYS_OLD: 'v2:s2,v1:s1',
  };
  const keys = derivedKeys(env, 'l')!;
  // «Шифр» для проверки порядка: тело = hex ключа; открывает только он.
  const opener = (body: string, key: Buffer) =>
    body === key.toString('hex') ? `ok:${body.slice(0, 4)}` : null;
  const bodyOf = (v: string) => keys.key(v)!.toString('hex');

  it('префикс `<версия>~` понимается при чтении (не пишется — Р-З10-25)', () => {
    expect(splitKeyVersion('v2~v1.a.b.c')).toEqual({
      version: 'v2',
      body: 'v1.a.b.c',
      prefixed: true,
    });
    expect(splitKeyVersion('v1.a.b.c')).toEqual({
      version: 'v1',
      body: 'v1.a.b.c',
      prefixed: false,
    });
    // base64 токена — не префикс; «v0~» — не версия.
    expect(splitKeyVersion('abc+/=.x.y').prefixed).toBe(false);
    expect(splitKeyVersion('v0~x').prefixed).toBe(false);
  });

  it('с префиксом — только ключ своей версии', () => {
    expect(openWithKeys(keys, `v2~${bodyOf('v2')}`, opener)?.version).toBe(
      'v2',
    );
    // Тело ключа v3 под меткой v2 — не открывается (без перебора).
    expect(openWithKeys(keys, `v2~${bodyOf('v3')}`, opener)).toBeNull();
    // Версии нет в связке — null.
    expect(openWithKeys(keys, `v7~${bodyOf('v3')}`, opener)).toBeNull();
  });

  it('без префикса — ключи по порядку связки: текущий, затем прежние', () => {
    expect(openWithKeys(keys, bodyOf('v1'), opener)?.version).toBe('v1');
    expect(openWithKeys(keys, bodyOf('v2'), opener)?.version).toBe('v2');
    expect(openWithKeys(keys, bodyOf('v3'), opener)?.version).toBe('v3');
    expect(openWithKeys(keys, 'deadbeef', opener)).toBeNull();
    const order: string[] = [];
    openWithKeys(keys, 'x', (_b, k) => {
      order.push(keys.versions.find((v) => keys.key(v)!.equals(k)) as string);
      return null;
    });
    expect(order).toEqual(['v3', 'v2', 'v1']);
  });

  it('hmacKeyList: один ключ или список', () => {
    const a = Buffer.from('a');
    expect(hmacKeyList(a)).toEqual([a]);
    expect(hmacKeyList([a, a])).toHaveLength(2);
  });
});
