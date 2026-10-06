/**
 * employee-JWT генератора против НАСТОЯЩЕЙ проверки платформы
 * (`sites-backend/.../identity-jwt.ts` — чистый модуль, импорт напрямую):
 * токен, который мы выписываем, обязан приниматься ею, а чужой секрет,
 * чужой сайт и лишний срок — отвергаться.
 */
import { createHmac } from 'crypto';
import {
  IDENTITY_MAX_TTL_SEC,
  verifyEmployeeJwt,
} from '../../../../sites-backend/src/modules/assist-admin-mode/identity-jwt';
import { actorOf, signGuideJwt, userIdOfActor } from './guide-assist-jwt';

const SECRET = 'x'.repeat(48);
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

function sign(over: Partial<Parameters<typeof signGuideJwt>[0]> = {}) {
  return signGuideJwt({
    userId: 'ckuser123',
    siteId: 'site_v4c',
    role: 'creator',
    ttlSec: 600,
    jwtSecret: SECRET,
    nowMs: NOW,
    ...over,
  });
}

describe('Ш6 — employee-JWT пользователя TMA', () => {
  it('принимается проверкой платформы: sub — псевдоним, aud — сайт, роль', () => {
    const { jwt, exp } = sign();
    const id = verifyEmployeeJwt(jwt, SECRET, 'site_v4c', NOW);
    expect(id.sub).toBe(actorOf('ckuser123', SECRET));
    expect(id.sub.startsWith('g1.ckuser123.')).toBe(true);
    expect(id.role).toBe('creator');
    expect(id.name).toBeNull(); // имени в токене нет (Р-Ш6-4)
    expect(id.exp).toBe(exp);
    expect(exp - Math.floor(NOW / 1000)).toBe(600);
  });

  it('алгоритм — ровно HS256', () => {
    const header = JSON.parse(
      Buffer.from(sign().jwt.split('.')[0], 'base64url').toString(),
    );
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('чужой секрет — signature; другой сайт — audience', () => {
    const { jwt } = sign();
    expect(() =>
      verifyEmployeeJwt(jwt, 'y'.repeat(48), 'site_v4c', NOW),
    ).toThrow(/signature/);
    expect(() => verifyEmployeeJwt(jwt, SECRET, 'site_other', NOW)).toThrow(
      /audience/,
    );
  });

  it('срок никогда не больше 15 мин, даже если попросили больше', () => {
    const { jwt, exp } = sign({ ttlSec: 3600 });
    expect(exp - Math.floor(NOW / 1000)).toBe(IDENTITY_MAX_TTL_SEC);
    expect(() => verifyEmployeeJwt(jwt, SECRET, 'site_v4c', NOW)).not.toThrow();
  });

  it('истёкший — отвергается платформой', () => {
    const { jwt } = sign();
    expect(() =>
      verifyEmployeeJwt(jwt, SECRET, 'site_v4c', NOW + 20 * 60_000),
    ).toThrow(/expired/);
  });
});

describe('Ш6 — sub ↔ пользователь генератора (X-V4C-Actor)', () => {
  it('свой псевдоним → тот же пользователь', () => {
    expect(userIdOfActor(actorOf('ckuser123', SECRET), SECRET)).toBe(
      'ckuser123',
    );
  });

  it('подставленный чужой id с подписью другого — null (чужие факты не читаются)', () => {
    const mine = actorOf('ckuser123', SECRET);
    const forged = mine.replace('ckuser123', 'ckvictim9');
    expect(userIdOfActor(forged, SECRET)).toBeNull();
  });

  it('голый id, подпись чужим секретом, мусор — null', () => {
    expect(userIdOfActor('ckuser123', SECRET)).toBeNull();
    expect(
      userIdOfActor(actorOf('ckuser123', 'z'.repeat(48)), SECRET),
    ).toBeNull();
    expect(userIdOfActor(undefined, SECRET)).toBeNull();
    expect(userIdOfActor('g1..AAAA', SECRET)).toBeNull();
    expect(userIdOfActor(`${'g1.a.'}${'A'.repeat(200)}`, SECRET)).toBeNull();
  });

  it('ключ подписи sub — выведенный, а не сам секрет JWT', () => {
    const naive = createHmac('sha256', SECRET)
      .update('ckuser123')
      .digest('base64url')
      .slice(0, 22);
    expect(actorOf('ckuser123', SECRET)).not.toBe(`g1.ckuser123.${naive}`);
  });

  it('id недопустимой формы в sub не попадает', () => {
    expect(() => actorOf('a.b', SECRET)).toThrow();
    expect(() => actorOf('', SECRET)).toThrow();
  });
});
