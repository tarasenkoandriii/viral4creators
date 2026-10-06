/**
 * Подсказки распознаванию команды сотрудника «Админки» — `context.terms`
 * Soniox (Э6-бис-хвост (3)): имена и фразы ОПУБЛИКОВАННЫХ мемо «Админки»
 * (АМ-N) этого сайта. Отбор, потолки и проверка на ПД — нейтральный
 * `assist-ui-core/stt-terms.ts`; источник — только таблицы
 * `assist_admin_memo*` (основная роль, кабинет сайта).
 *
 * Изоляция режимов: «Сайт» собирает свои термины сам
 * (`assist-site-voice/public/stt-terms.ts`, роль `assist_public`, только
 * представления «Сайта») и этот файл не видит (правило графа site↛admin);
 * отсюда — ни мемо, ни карты «Сайта» (admin↛site). Голосовой карты
 * «Админки» ещё нет (Э6-тер-хвост (10)) — появится, добавится группой.
 *
 * Кэш — на сайт по версиям (мемо, опубликованная версия); свежая запись
 * 30 с без базы. Отказ базы — прежние термины или пусто.
 */
import { buildSttTerms } from '../assist-ui-core/stt-terms';
import { MEMO_LANGS } from '../assist-ui-core/memo';
import type { SitesDb } from '../../prisma/sites-db.service';
import { parseAdminMemo } from '../assist-admin-actions/admin-memo';

const FRESH_MS = 30_000;
const MAX_SITES = 5_000;

const cache = new Map<string, { at: number; sig: string; terms: string[] }>();

export function clearAdminSttTermsCache(): void {
  cache.clear();
}

/** Термины распознавания «Админки» сайта. Никогда не бросает. */
export async function adminSttTerms(
  sitesDb: SitesDb,
  p: { accountId: string; siteId: string },
  now = Date.now(),
): Promise<string[]> {
  const key = `${p.accountId}:${p.siteId}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < FRESH_MS) return hit.terms;
  try {
    const db = sitesDb.forAccount(p.accountId);
    const memos = await db.assistAdminMemo.findMany({
      where: {
        siteId: p.siteId,
        status: 'published',
        publishedVersion: { not: null },
      },
      select: { id: true, publishedVersion: true },
      orderBy: { number: 'asc' },
      take: 200,
    });
    const sig = memos.map((m) => `${m.id}@${m.publishedVersion}`).join(',');
    if (hit && hit.sig === sig) {
      hit.at = now;
      return hit.terms;
    }
    const versions = memos.length
      ? await db.assistAdminMemoVersion.findMany({
          where: {
            siteId: p.siteId,
            status: 'published',
            OR: memos.map((m) => ({
              memoId: m.id,
              number: m.publishedVersion as number,
            })),
          },
          select: { content: true },
        })
      : [];
    const contents = versions.map((v) => parseAdminMemo(v.content).content);
    const terms = buildSttTerms([
      contents.flatMap((c) => MEMO_LANGS.map((l) => c.names[l])),
      contents.flatMap((c) => MEMO_LANGS.flatMap((l) => c.triggers[l] ?? [])),
    ]);
    cache.delete(key);
    cache.set(key, { at: now, sig, terms });
    if (cache.size > MAX_SITES)
      cache.delete(cache.keys().next().value as string);
    return terms;
  } catch {
    return hit?.terms ?? [];
  }
}
