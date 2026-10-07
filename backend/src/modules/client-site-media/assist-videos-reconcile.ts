/**
 * Э6-хвост (W7): ночная сверка наборов роликов сайтов помощника.
 *
 * Набор сайта уходит в sites-backend по событиям (привязка/отвязка, ролик
 * собран, удаление черновика, удаление проекта). Сбой сети на событии
 * раньше доходил только со следующим событием этого сайта — а его могло не
 * быть неделями. Сверка раз в сутки (в кроне `client-site-retention`):
 * для каждого сайта — пересобрать набор и отправить, если он отличается от
 * последнего ПРИНЯТОГО sites-backend.
 *
 * Где хранится «последний принятый»: отпечаток набора (sha256 его JSON) и
 * время отправки — в `PlatformSetting` под ключом `assist-videos-hash:<siteId>`
 * (тот же приём, что у списка ожидания удалений Resemble). Без миграции:
 * схему backend в этом заходе правит другой этап, а строка «сайт → хеш» —
 * служебное состояние, не настройка. Пишет его сам `syncSite` при успехе
 * (не при `stale`), так что сверка шлёт только то, что не дошло.
 *
 * Сайты сверки — объединение: привязанные черновики + сайты с отпечатком
 * (у сайта, чьи черновики удалены целиком, привязок уже нет, а пустой набор
 * мог не дойти). Пустой набор сайта без привязок, принятый sites-backend, —
 * отпечаток стирается: сверять больше нечего.
 *
 * Раз в `RECONCILE_RESEND_AFTER_MS` набор уходит и без изменений: sites-backend
 * мог потерять или отбросить его (восстановление базы, ручная правка).
 * Потолки прогона — `RECONCILE_MAX_SENDS` отправок и `RECONCILE_BUDGET_MS`;
 * что не успели — следующей ночью (порядок — сначала давно не сверенные).
 *
 * Аудит [P3] (голодание): неудачная отправка тоже оставляет запись —
 * `0|<время попытки>|<отказов подряд>` (без отпечатка: набор отправится
 * снова), — и сайт уходит в КОНЕЦ очереди по времени попытки. Иначе сайт с
 * вечно падающей отправкой (удалён в sites-backend) стоял бы первым каждую
 * ночь, и при ≥ 30 таких или медленном sites-backend до остальных очередь
 * не доходила бы никогда. Отказ «сайт не найден / не ваш» (403/404/409)
 * считается подряд; после `RECONCILE_GIVE_UP_AFTER` — сайт без привязок
 * забывается, с привязками — пробуется раз в `RECONCILE_RESEND_AFTER_MS`.
 */
import { createHash } from 'crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SitesVideoInput } from '../sites-internal/sites-internal.client';

export const ASSIST_VIDEOS_HASH_PREFIX = 'assist-videos-hash:';
/** Отправок за прогон: каждая — до 15 с таймаута sites-backend. */
export const RECONCILE_MAX_SENDS = 30;
/** Бюджет прогона сверки (мс) — крон делит функцию с уборкой хранения. */
export const RECONCILE_BUDGET_MS = 90_000;
/** Неизменный набор всё равно переотправляется раз в неделю. */
export const RECONCILE_RESEND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Отказов «сайт не найден / не ваш» подряд, после которых сайт не дёргаем. */
export const RECONCILE_GIVE_UP_AFTER = 3;

export interface AssistVideosReconcileResult {
  sites: number;
  unchanged: number;
  sent: number;
  failed: number;
  forgotten: number;
  /** Сайт отвергнут sites-backend ≥ N раз подряд — ждёт недельной попытки. */
  gaveUp: number;
  /** Не дошла очередь (потолок отправок или времени) — следующей ночью. */
  deferred: number;
  skipped?: 'not-configured';
}

/** Отпечаток набора — порядок ролика важен (от новых), `asOf` не входит. */
export function videoSetHash(videos: readonly SitesVideoInput[]): string {
  return createHash('sha256').update(JSON.stringify(videos)).digest('hex');
}

export interface StoredVideoSet {
  /** `null` — последняя попытка не удалась (набор отправится снова). */
  hash: string | null;
  /** Время последней попытки (успешной или нет), мс. */
  at: number;
  /** Отказов «сайт не найден / не ваш» подряд. */
  fails: number;
}

export function parseStoredVideoSet(
  value: string | null | undefined,
): StoredVideoSet | null {
  const m = /^([0-9a-f]{64}|0)\|(\d{1,15})(?:\|(\d{1,4}))?$/.exec(value ?? '');
  if (!m) return null;
  return {
    hash: m[1] === '0' ? null : m[1],
    at: Number(m[2]),
    fails: m[3] ? Number(m[3]) : 0,
  };
}

type SettingsDb = Pick<PrismaService, 'platformSetting'>;

/** Набор принят sites-backend — запомнить отпечаток. Никогда не бросает. */
export async function rememberVideoSet(
  prisma: SettingsDb,
  siteId: string,
  videos: readonly SitesVideoInput[],
  now: number,
): Promise<void> {
  const key = `${ASSIST_VIDEOS_HASH_PREFIX}${siteId}`;
  const value = `${videoSetHash(videos)}|${now}`;
  try {
    await prisma.platformSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  } catch {
    // Не записали — сверка просто отправит набор ещё раз.
  }
}

/**
 * Отправка не удалась — запомнить время попытки (без отпечатка), чтобы
 * сайт ушёл в конец очереди сверки. `permanent` — sites-backend ответил
 * «сайт не найден / не ваш»: счётчик подряд +1; сбой сети — не меняет его.
 * Никогда не бросает.
 */
export async function rememberSyncFailure(
  prisma: SettingsDb,
  siteId: string,
  now: number,
  permanent: boolean,
): Promise<void> {
  const key = `${ASSIST_VIDEOS_HASH_PREFIX}${siteId}`;
  try {
    const row = (await prisma.platformSetting.findUnique({
      where: { key },
      select: { value: true },
    })) as { value: string } | null;
    const prev = parseStoredVideoSet(row?.value)?.fails ?? 0;
    const fails = Math.min(prev + (permanent ? 1 : 0), 9999);
    const value = `0|${now}|${fails}`;
    await prisma.platformSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  } catch {
    // Не записали — сайт останется в прежнем месте очереди.
  }
}

export async function forgetVideoSet(
  prisma: SettingsDb,
  siteId: string,
): Promise<void> {
  try {
    await prisma.platformSetting.deleteMany({
      where: { key: `${ASSIST_VIDEOS_HASH_PREFIX}${siteId}` },
    });
  } catch {
    // Останется — следующая сверка попробует снова.
  }
}

/** То, что сверке нужно от `ClientSiteMediaService` (без цикла импорта). */
export interface ReconcileMedia {
  collectVideos(siteId: string): Promise<SitesVideoInput[]>;
  syncSite(siteId: string): Promise<boolean>;
}

export async function reconcileAssistVideoSets(deps: {
  prisma: Pick<PrismaService, 'platformSetting' | 'clientSiteTutorialDraft'>;
  media: ReconcileMedia;
  configured: boolean;
  /** id сайта лендинга (`ASSIST_LANDING_SITE_ID`) — его набор ведёт не сверка. */
  landingSiteId: string | null;
  now?: () => number;
  maxSends?: number;
  budgetMs?: number;
}): Promise<AssistVideosReconcileResult> {
  const now = deps.now ?? (() => Date.now());
  const result: AssistVideosReconcileResult = {
    sites: 0,
    unchanged: 0,
    sent: 0,
    failed: 0,
    forgotten: 0,
    gaveUp: 0,
    deferred: 0,
  };
  if (!deps.configured) return { ...result, skipped: 'not-configured' };
  const started = now();
  const maxSends = deps.maxSends ?? RECONCILE_MAX_SENDS;
  const budgetMs = deps.budgetMs ?? RECONCILE_BUDGET_MS;

  const linked = (await deps.prisma.clientSiteTutorialDraft.findMany({
    where: { clientSiteId: { not: null } },
    select: { clientSiteId: true },
    distinct: ['clientSiteId'],
  })) as Array<{ clientSiteId: string | null }>;
  const stored = (await deps.prisma.platformSetting.findMany({
    where: { key: { startsWith: ASSIST_VIDEOS_HASH_PREFIX } },
    select: { key: true, value: true },
  })) as Array<{ key: string; value: string }>;

  const linkedIds = new Set(
    linked.map((d) => d.clientSiteId).filter((v): v is string => !!v),
  );
  const storedById = new Map(
    stored.map((r) => [
      r.key.slice(ASSIST_VIDEOS_HASH_PREFIX.length),
      parseStoredVideoSet(r.value),
    ]),
  );
  const ids = [...new Set([...linkedIds, ...storedById.keys()])].filter(
    (id) => id && id !== deps.landingSiteId,
  );
  // Сначала без записи, потом по времени последней попытки (успешной или
  // нет): потолок прогона не должен навсегда оставлять одни и те же сайты в
  // хвосте, а вечно падающие — вечно стоять в голове (аудит [P3]).
  ids.sort(
    (a, b) =>
      (storedById.get(a)?.at ?? 0) - (storedById.get(b)?.at ?? 0) ||
      a.localeCompare(b),
  );
  result.sites = ids.length;

  let sends = 0;
  for (const siteId of ids) {
    if (sends >= maxSends || now() - started > budgetMs) {
      result.deferred++;
      continue;
    }
    const prev = storedById.get(siteId) ?? null;
    if (prev && prev.hash === null && prev.fails >= RECONCILE_GIVE_UP_AFTER) {
      if (!linkedIds.has(siteId)) {
        // Сайта нет в sites-backend, привязок нет — сверять нечего.
        await forgetVideoSet(deps.prisma, siteId);
        result.forgotten++;
        continue;
      }
      if (now() - prev.at < RECONCILE_RESEND_AFTER_MS) {
        result.gaveUp++;
        continue;
      }
    }
    const videos = await deps.media.collectVideos(siteId);
    const hash = videoSetHash(videos);
    const fresh =
      !!prev &&
      prev.hash === hash &&
      now() - prev.at < RECONCILE_RESEND_AFTER_MS;
    if (fresh && !(videos.length === 0 && !linkedIds.has(siteId))) {
      result.unchanged++;
      continue;
    }
    if (fresh) {
      // Пустой набор сайта без привязок уже принят — сверять больше нечего.
      await forgetVideoSet(deps.prisma, siteId);
      result.forgotten++;
      continue;
    }
    sends++;
    // `syncSite` сам пишет отпечаток при успехе (и не пишет при `stale`).
    if (await deps.media.syncSite(siteId)) result.sent++;
    else result.failed++;
  }
  return result;
}
