// Подписи пользователей («@username», имя, аватар) для голых id на любом
// экране админки. Бейджей на странице бывают десятки (строка таблицы —
// бейдж), и запрос на каждый положил бы бэкенд и сам экран, поэтому:
//
// - id со всех бейджей копятся до конца тика (`setTimeout 0`, а не
//   microtask: эффекты разных веток дерева могут прийти разными коммитами
//   одного тика) и уходят ОДНИМ запросом `users/brief` (частями по 200 —
//   больше бэкенд не принимает);
// - ответ живёт в памяти модуля до перезагрузки вкладки: переход между
//   экранами админки не повторяет запрос за теми же людьми;
// - аватар — fetch с credentials → blob → object URL. `<img src>` прямо на
//   бэкенд нельзя: cookie AdminSession для браузера сторонняя и не уйдёт.
//   «Фото нет» (404) запоминается так же, как фото, — без повторов.
//
// React здесь нет намеренно: логика кеша (фабрика с подменяемыми
// зависимостями) проверяется без браузера, а хук поверх неё — в
// components/UserBadge.tsx.

import { getUserAvatar, getUserBriefs } from './endpoints';
import type { AdminUserBrief } from './types';

/** Больше за один запрос бэкенд не принимает (контракт `users/brief`). */
export const BRIEF_BATCH_LIMIT = 200;

/**
 * Настоящий id пользователя — cuid (`@default(cuid())` в схеме). Всё
 * остальное в полях вроде `triggeredBy` — служебные значения
 * (`vercel-cron`, `proactive`), их показываем как есть и не запрашиваем.
 */
export function isUserId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^c[a-z0-9]{20,31}$/.test(value);
}

/**
 * Аватар есть смысл спрашивать только у числового telegramId: у dev- и
 * fixture-пользователей он строковый, и бэкенд всё равно ответит 404.
 */
export function canHaveAvatar(brief: AdminUserBrief | null | undefined): boolean {
  return !!brief && /^\d+$/.test(brief.telegramId);
}

export interface UserBriefDeps {
  fetchBriefs: (ids: string[]) => Promise<AdminUserBrief[]>;
  fetchAvatar: (id: string) => Promise<Blob | null>;
  schedule: (fn: () => void) => void;
  toObjectUrl: (blob: Blob) => string;
}

export interface UserBriefStore {
  /** undefined — ещё не знаем; null — бэкенд такого id не знает. */
  getBrief(id: string): AdminUserBrief | null | undefined;
  /** undefined — ещё не знаем; null — фото нет; строка — object URL. */
  getAvatar(id: string): string | null | undefined;
  /** Поставить id в ближайший батч (повторы и уже известные — игнор). */
  requestBrief(id: string): void;
  /** Скачать аватар (один раз на id за жизнь вкладки). */
  requestAvatar(id: string): void;
  /** Экраны, которые уже получили пользователей целиком, кладут их сюда. */
  prime(briefs: AdminUserBrief[]): void;
  subscribe(listener: () => void): () => void;
}

export function createUserBriefStore(deps: UserBriefDeps): UserBriefStore {
  const briefs = new Map<string, AdminUserBrief | null>();
  const avatars = new Map<string, string | null>();
  const queued = new Set<string>();
  const inFlight = new Set<string>();
  const avatarsInFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let scheduled = false;

  const emit = () => {
    for (const l of listeners) l();
  };

  const flush = () => {
    scheduled = false;
    const ids = [...queued];
    queued.clear();
    for (let i = 0; i < ids.length; i += BRIEF_BATCH_LIMIT) {
      const chunk = ids.slice(i, i + BRIEF_BATCH_LIMIT);
      for (const id of chunk) inFlight.add(id);
      deps
        .fetchBriefs(chunk)
        .then((rows) => {
          const byId = new Map(rows.map((r) => [r.id, r]));
          // Отсутствие в ответе — это ответ «такого нет», его тоже
          // запоминаем, иначе бейдж будет спрашивать на каждом экране.
          for (const id of chunk) briefs.set(id, byId.get(id) ?? null);
        })
        .catch(() => {
          // Сеть/5xx — не приговор id: не кешируем, бейдж покажет короткий
          // id, а следующий экран спросит снова.
        })
        .finally(() => {
          for (const id of chunk) inFlight.delete(id);
          emit();
        });
    }
  };

  return {
    getBrief: (id) => briefs.get(id),
    getAvatar: (id) => avatars.get(id),

    requestBrief(id) {
      if (!isUserId(id)) return;
      if (briefs.has(id) || queued.has(id) || inFlight.has(id)) return;
      queued.add(id);
      if (!scheduled) {
        scheduled = true;
        deps.schedule(flush);
      }
    },

    requestAvatar(id) {
      if (avatars.has(id) || avatarsInFlight.has(id)) return;
      avatarsInFlight.add(id);
      deps
        .fetchAvatar(id)
        .then((blob) => {
          avatars.set(id, blob ? deps.toObjectUrl(blob) : null);
        })
        .catch(() => {
          // Не 404, а сбой — не запоминаем «нет фото»: оно может быть.
        })
        .finally(() => {
          avatarsInFlight.delete(id);
          emit();
        });
    },

    prime(rows) {
      if (rows.length === 0) return;
      for (const r of rows) {
        briefs.set(r.id, {
          id: r.id,
          telegramId: r.telegramId,
          username: r.username,
          firstName: r.firstName,
          isOperator: r.isOperator,
          isTestUser: r.isTestUser,
        });
      }
      emit();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let defaultStore: UserBriefStore | null = null;

/** Общий на вкладку экземпляр; ленивый — модуль импортируется и на сервере. */
export function userBriefs(): UserBriefStore {
  if (!defaultStore) {
    defaultStore = createUserBriefStore({
      fetchBriefs: getUserBriefs,
      fetchAvatar: getUserAvatar,
      schedule: (fn) => {
        setTimeout(fn, 0);
      },
      toObjectUrl: (blob) => URL.createObjectURL(blob),
    });
  }
  return defaultStore;
}

/** Подпись по контракту: @username → имя → tg <telegramId> → короткий id. */
export function briefLabel(id: string, brief: AdminUserBrief | null | undefined): string {
  if (brief?.username) return `@${brief.username}`;
  if (brief?.firstName) return brief.firstName;
  if (brief?.telegramId) return `tg ${brief.telegramId}`;
  return `${id.slice(0, 8)}…`;
}

/** Буква в кружке, пока фото нет: первая буква имени, иначе «@». */
export function briefInitial(brief: AdminUserBrief | null | undefined): string {
  const name = brief?.firstName?.trim();
  if (name) return name[0].toUpperCase();
  if (brief?.username) return '@';
  return '?';
}
