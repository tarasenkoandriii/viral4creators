/**
 * Контракт-тест backend ↔ sites-backend для вкладки «Reddit» (P-R-ADM):
 * таблица генератора `ADMIN_REDDIT_ROUTES` совпадает с тем, что реально
 * принимает внутренний API (`sites-backend/src/modules/publisher/reddit/
 * admin/admin-reddit-routes.ts`): `rx/*` — все маршруты `REDDIT_ROUTES`,
 * `cx/*` — список студии, ключи параметров — гейт `reddit_publish` + P-R.
 * Разъедутся (добавили маршрут кабинета, переименовали путь студии) —
 * падает здесь, а не у оператора 404-м.
 */
import * as fs from 'fs';
import * as path from 'path';
import { REDDIT_ROUTES } from '../../../../sites-backend/src/modules/publisher/contracts/reddit-api';
import {
  BUDGET_LIMIT_PARAMETER_KEYS,
  GATE_PARAMETER_KEYS,
} from '../../../../sites-backend/src/modules/publisher/contracts/parameters';
import {
  ADMIN_REDDIT_PARAM_KEYS,
  ADMIN_REDDIT_ROUTES,
  AdminRedditRouteName,
  PUB_ID_RE,
} from './admin-reddit.routes';

const SITES_ADMIN_ROUTES = path.resolve(
  __dirname,
  '../../../../sites-backend/src/modules/publisher/reddit/admin/admin-reddit-routes.ts',
);
const SITES_ADMIN_ACTOR = path.resolve(
  __dirname,
  '../../../../sites-backend/src/modules/publisher/core/admin-actor.ts',
);

const ours = (prefix: string) =>
  (Object.keys(ADMIN_REDDIT_ROUTES) as AdminRedditRouteName[])
    .map((n) => ADMIN_REDDIT_ROUTES[n])
    .filter((r) => r.path.startsWith(prefix))
    .map((r) => `${r.method} ${r.path.slice(prefix.length)}`)
    .sort();

describe('вкладка «Reddit»: таблица генератора = внутренний API sites-backend', () => {
  it('rx/* — ровно маршруты REDDIT_ROUTES кабинета (метод и путь после …/reddit/)', () => {
    const prefix = '/publisher/products/:pid/reddit/';
    const theirs = Object.values(REDDIT_ROUTES)
      .map((r) => `${r.method} ${r.path.slice(prefix.length)}`)
      .sort();
    expect(theirs).toHaveLength(39);
    expect(ours('rx/')).toEqual(theirs);
  });

  it('cx/* — ровно список студии CX_ROUTES', () => {
    const src = fs.readFileSync(SITES_ADMIN_ROUTES, 'utf8');
    const block = src.slice(src.indexOf('export const CX_ROUTES'));
    const theirs = [
      ...block.matchAll(/method: '(GET|POST|PATCH)',\s*pattern: '([^']+)'/g),
    ]
      .map((m) => `${m[1]} ${m[2]}`)
      .sort();
    expect(theirs).toHaveLength(24);
    expect(ours('cx/')).toEqual(theirs);
  });

  it('формат id в пути — тот же, что ID_RE внутреннего API', () => {
    const src = fs.readFileSync(SITES_ADMIN_ROUTES, 'utf8');
    const m = /const ID_RE = \/(.+)\/;/.exec(src);
    expect(m?.[1]).toBe(PUB_ID_RE.source);
  });

  it('ключи параметров — ровно ADMIN_PARAMETER_KEYS sites-backend (v1.4: 13; спреды списков разворачиваются по contracts/parameters.ts)', () => {
    const actor = fs.readFileSync(SITES_ADMIN_ACTOR, 'utf8');
    const start = actor.indexOf('export const ADMIN_PARAMETER_KEYS');
    expect(start).toBeGreaterThan(-1);
    const block = actor.slice(start, actor.indexOf('];', start));
    const lists: Record<string, readonly string[]> = {
      ...Object.fromEntries(
        Object.entries(GATE_PARAMETER_KEYS).map(([g, keys]) => [
          `GATE_PARAMETER_KEYS.${g}`,
          keys as readonly string[],
        ]),
      ),
      BUDGET_LIMIT_PARAMETER_KEYS,
    };
    const theirs = new Set<string>();
    for (const m of block.matchAll(
      /\.\.\.([A-Z_]+(?:\.[a-z_]+)?)\b|'([a-z_]+)'/g,
    )) {
      if (m[2]) {
        theirs.add(m[2]);
        continue;
      }
      if (m[1] === 'new') continue;
      const list = lists[m[1]];
      // Новый спред, которого тест не знает, — тоже расхождение.
      expect([m[1], list !== undefined]).toEqual([m[1], true]);
      for (const k of list) theirs.add(k);
    }
    expect(theirs.size).toBe(13);
    expect([...ADMIN_REDDIT_PARAM_KEYS].sort()).toEqual([...theirs].sort());
  });
});
