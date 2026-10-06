/**
 * Мемо в файле голосовой карты (Э6-тер (к), ТЗ §5-бис.17 п.6, п.15 п.7;
 * §5-кватер.12) — сторона базы для `VoiceMapService.exportFile/importFile`:
 *
 *  - экспорт: мемо сайта (кроме удалённых), черновик — переносимым
 *    содержимым `memoExportItem` (без номеров, id, `pin`, Ш4, предложенных
 *    фраз и статистики), по номеру;
 *  - импорт: `memoImportItems` (строгий разбор, ворота кода на ЭТОМ сайте,
 *    опасные шаги — отказ в отчёте) → черновики пакетом с лимитом тарифа в
 *    транзакции (`insertMemoDrafts`, origin/источник `import`). Ничего не
 *    публикуется; привязка шага к цели карты — только к цели этой карты.
 */
import { MEMO_LANGS, parseMemoContent } from '../assist-ui-core/memo';
import { memoExportItem, memoImportItems } from '../assist-ui-core/memo-io';
import { defaultVoiceControlRules, rulesOf } from '../assist-ui-core/rules';
import { insertMemoDrafts } from '../assist-site-voice-control/cabinet/memo-drafts';
import type { SitesDb } from '../../prisma/sites-db.service';

type Db = ReturnType<SitesDb['forAccount']>;

/** Отчёт импорта мемо (поле `memos` ответа импорта карты). */
export interface MemoImportReport {
  created: Array<{ number: number; key: string; name: string | null }>;
  rejected: Array<{
    index: number;
    key: string | null;
    code: string;
    path: string | null;
  }>;
}

export async function exportMemos(
  db: Db,
  siteId: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await db.assistSiteMemo.findMany({
    where: { siteId, status: { not: 'removed' } },
    orderBy: { number: 'asc' },
    select: { key: true, listed: true, draft: true },
  });
  return rows.map((r) =>
    memoExportItem({
      key: r.key,
      listed: r.listed,
      content: parseMemoContent(r.draft).content,
    }),
  );
}

export async function importMemos(
  db: Db,
  p: {
    accountId: string;
    memberId: string;
    siteId: string;
    /** Правила голосового управления сайта (`voiceControlSiteRules`). */
    rulesRaw: unknown;
    /** Подтверждённые хосты «Сайта» (первый — для фактов ссылок шагов). */
    hosts: readonly string[];
    /** Ключи целей карты сайта (после импорта целей). */
    mapKeys: ReadonlySet<string>;
    memos: unknown;
    now: Date;
  },
): Promise<MemoImportReport> {
  const rules = rulesOf(p.rulesRaw) ?? defaultVoiceControlRules();
  const parsed = memoImportItems(p.memos, {
    rules,
    host: p.hosts[0] ?? 'example.invalid',
    mapKeys: p.mapKeys,
  });
  const rejected: MemoImportReport['rejected'] = parsed.rejected.map((r) => ({
    ...r,
  }));
  const res = await insertMemoDrafts(db, {
    accountId: p.accountId,
    memberId: p.memberId,
    siteId: p.siteId,
    origin: 'import',
    items: parsed.accepted,
    now: p.now,
  });
  for (const r of res.rejected)
    rejected.push({ index: r.index, key: r.key, code: r.code, path: null });
  rejected.sort((a, b) => a.index - b.index);
  const byIndex = new Map(parsed.accepted.map((a) => [a.index, a.content]));
  return {
    created: res.created.map((c) => {
      const content = byIndex.get(c.index);
      return {
        number: c.number,
        key: c.key,
        name: content
          ? (MEMO_LANGS.map((l) => content.names[l]).find(Boolean) ?? null)
          : null,
      };
    }),
    rejected,
  };
}
