/**
 * Заход 9, Р-З9-13: шифр `liveValues` голосового плана — AES-256-GCM
 * производным ключом `ASSIST_SECRETS_KEY` с версией и AAD (план, сайт).
 * Мутанты, которые тест обязан убить: запись открытым текстом; AAD без
 * плана/сайта (перестановка шифротекста); нет ключа — запись открытым;
 * старый ключ после ротации не читается; старый открытый формат не читается.
 */
import {
  liveKeysFrom,
  LiveCryptError,
  openLive,
  sealLive,
} from './live-crypto';

const env = (o: Record<string, string> = {}) =>
  ({ ASSIST_SECRETS_KEY: 'k-current', ...o }) as NodeJS.ProcessEnv;
const a = { planId: 'p1', siteId: 's1' };
const plain = JSON.stringify({
  u: 'набери +380501234567',
  v: ['+380501234567'],
});

describe('live-crypto (заход 9, Р-З9-13)', () => {
  it('шифротекст `{v,kv,ct}` без открытого текста; открывается тем же ключом и AAD', () => {
    const keys = liveKeysFrom(env());
    const sealed = sealLive(keys, plain, a);
    expect(sealed).not.toContain('380501234567');
    expect(sealed).not.toContain('набери');
    const o = JSON.parse(sealed) as Record<string, unknown>;
    expect(Object.keys(o).sort()).toEqual(['ct', 'kv', 'v']);
    expect(o).toMatchObject({ v: 1, kv: 'v1' });
    expect(openLive(keys, o, a)).toEqual(JSON.parse(plain));
    // Два шифрования одного текста — разные (случайный IV).
    expect(sealLive(keys, plain, a)).not.toBe(sealed);
  });

  it('AAD: чужой план, чужой сайт, порча, чужой ключ — null', () => {
    const keys = liveKeysFrom(env());
    const o = JSON.parse(sealLive(keys, plain, a)) as { ct: string };
    expect(openLive(keys, o, { ...a, planId: 'p2' })).toBeNull();
    expect(openLive(keys, o, { ...a, siteId: 's2' })).toBeNull();
    const bad = {
      ...o,
      ct: o.ct.slice(0, -2) + (o.ct.endsWith('A') ? 'B' : 'A'),
    };
    expect(openLive(keys, bad, a)).toBeNull();
    expect(
      openLive(liveKeysFrom(env({ ASSIST_SECRETS_KEY: 'x' })), o, a),
    ).toBeNull();
    expect(openLive(null, o, a)).toBeNull();
  });

  it('нет ключа — записи нет (ошибка), а не открытый текст', () => {
    expect(liveKeysFrom({} as NodeJS.ProcessEnv)).toBeNull();
    expect(() => sealLive(null, plain, a)).toThrow(LiveCryptError);
  });

  it('ротация: новый ключ v2 пишет, прежний v1 из ASSIST_SECRETS_KEYS_OLD читается', () => {
    const v1 = liveKeysFrom(env());
    const old = JSON.parse(sealLive(v1, plain, a)) as unknown;
    const v2 = liveKeysFrom(
      env({
        ASSIST_SECRETS_KEY: 'k-next',
        ASSIST_SECRETS_KEY_VERSION: 'v2',
        ASSIST_SECRETS_KEYS_OLD: 'v1:k-current',
      }),
    );
    expect(openLive(v2, old, a)).toEqual(JSON.parse(plain));
    expect(JSON.parse(sealLive(v2, plain, a))).toMatchObject({ kv: 'v2' });
    expect(() =>
      liveKeysFrom(env({ ASSIST_SECRETS_KEYS_OLD: 'v1:dup' })),
    ).toThrow(LiveCryptError);
  });

  it('переход: старый открытый формат `{u,v}` читается (≤ 10 мин), мусор — null', () => {
    const keys = liveKeysFrom(env());
    expect(openLive(keys, { u: 'x', v: ['y'] }, a)).toEqual({
      u: 'x',
      v: ['y'],
    });
    expect(openLive(keys, null, a)).toBeNull();
    expect(openLive(keys, [1], a)).toBeNull();
    expect(openLive(keys, { v: 1, kv: 'v1', ct: 'a.b' }, a)).toBeNull();
  });
});
