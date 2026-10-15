/**
 * AI Publisher, P-R-ADM — клиент внутреннего API вкладки «Reddit» Админки
 * для приёмки (`acceptance/publisher/reddit-admin-*.spec.ts`): секрет,
 * актор, платформенный сайт (`ASSIST_INTERNAL_SITE_IDS`) на время набора.
 */
import { randomUUID } from 'crypto';
import * as supertest from 'supertest';
import { PUBLISHER_PLATFORM_SITE_IDS_ENV } from '../../../../config/publisher-env';
import type { RedditStack } from './reddit-kit.testing';

/** Тестовый секрет (≥ 16 знаков; только тесты). */
export const ADMIN_SECRET = 'admin-reddit-internal-secret-test-0001';
export const ADMIN_BASE = '/internal/admin/reddit';
export const ADMIN_USER = 'clOperatorUser0001';

const KEYS = ['SITES_INTERNAL_SECRET', PUBLISHER_PLATFORM_SITE_IDS_ENV];

/** Секрет и платформенный сайт; вернуть — `restore()`. */
export function useAdminEnv(siteIds: string | null): () => void {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SITES_INTERNAL_SECRET = ADMIN_SECRET;
  if (siteIds === null) delete process.env[PUBLISHER_PLATFORM_SITE_IDS_ENV];
  else process.env[PUBLISHER_PLATFORM_SITE_IDS_ENV] = siteIds;
  return () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

export interface AdminHeaders {
  secret?: string | null;
  actor?: string | null;
}

/** Клиент Админки → sites-backend (тело мутации получает свежий `opKey`). */
export function adminApi(s: Pick<RedditStack, 'srv'>, h: AdminHeaders = {}) {
  const headers: Record<string, string> = { 'Accept-Language': 'ru' };
  const secret = h.secret === undefined ? ADMIN_SECRET : h.secret;
  const actor = h.actor === undefined ? ADMIN_USER : h.actor;
  if (secret !== null) headers['X-Sites-Internal-Secret'] = secret;
  if (actor !== null) headers['X-Admin-Actor'] = actor;
  const url = (p: string) => `${ADMIN_BASE}/${p.replace(/^\//, '')}`;
  return {
    headers,
    actor,
    get: (path: string, query: Record<string, string> = {}) =>
      supertest(s.srv()).get(url(path)).query(query).set(headers),
    post: (path: string, body: Record<string, unknown> = {}) =>
      supertest(s.srv())
        .post(url(path))
        .set(headers)
        .send({ opKey: randomUUID(), ...body }),
    /** Без автоматического `opKey` (setup, импорт, точное тело). */
    postRaw: (path: string, body: unknown) =>
      supertest(s.srv())
        .post(url(path))
        .set(headers)
        .send(body as object),
    patch: (path: string, body: Record<string, unknown> = {}) =>
      supertest(s.srv())
        .patch(url(path))
        .set(headers)
        .send({ opKey: randomUUID(), ...body }),
  };
}
export type AdminApi = ReturnType<typeof adminApi>;
