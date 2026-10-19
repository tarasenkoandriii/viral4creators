import { Prisma } from '@prisma/client';
import { acceptanceStatus } from './qa-attempt-status';
/**
 * Сводка прогона qa-catalog для внешнего потребителя (Р-PUB-Z2-27,
 * предаудит DEF-C-07 / B1-F-03): гейты запуска AI Publisher принимают как
 * доказательство приёмки не свободную строку, а id сохранённого прогона —
 * существующего в кабинете, с версиями кейсов в снимке и статусом
 * последней попытки каждого кейса.
 *
 * Модуль Publisher qa-catalog не импортирует (граф `publisher-leaf`), а
 * qa-catalog не знает Publisher: провайдер кладётся под строковым токеном
 * (`QA_RUN_EVIDENCE_TOKEN`), форма ответа — структурная (её повторяет
 * порт Publisher, совпадение проверяет приёмочный тест). Только чтение,
 * без прав участника: потребитель сам решает, кто вправе ссылаться на
 * прогон (у Publisher — решение владельца по параметру).
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';

export const QA_RUN_EVIDENCE_TOKEN = 'PUB_QA_RUN_EVIDENCE_PORT';

const SHA = /^[a-f0-9]{40}$/i;

/**
 * Версия кода, которую сейчас выпускает этот процесс (внутренний аудит
 * IA-AB-04, ТЗ §28): `PUBLISHER_RELEASE_SHA` (явно, вне Vercel), иначе
 * `VERCEL_GIT_COMMIT_SHA` (системная переменная Vercel), иначе
 * `GITHUB_SHA` (стенд в CI). Только полный sha (40 hex); иначе `null` —
 * версия неизвестна, доказательство приёмки не принимается.
 */
export function releaseCodeSha(
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (const k of [
    'PUBLISHER_RELEASE_SHA',
    'VERCEL_GIT_COMMIT_SHA',
    'GITHUB_SHA',
  ]) {
    const v = env[k]?.trim();
    if (v) return SHA.test(v) ? v.toLowerCase() : null;
  }
  return null;
}

/**
 * Commit, который удостоверяет попытка (IA-AB-04): `deployedSha` (код
 * стенда, на котором шли e2e) или, без него, `testSourceSha` (jest в
 * процессе — код теста и есть проверенный код). Ручная попытка и отчёт
 * без sha — `null`.
 */
export function attemptCodeSha(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as { deployedSha?: unknown; testSourceSha?: unknown };
  const pick = (v: unknown): string | null =>
    typeof v === 'string' && SHA.test(v) ? v.toLowerCase() : null;
  return pick(m.deployedSha) ?? pick(m.testSourceSha);
}

export interface QaRunEvidenceView {
  runId: string;
  siteId: string;
  title: string;
  createdAt: Date;
  /**
   * `caseKey` → версия кейса в снимке прогона и статус ПОСЛЕДНЕЙ попытки
   * (`null` — кейс в снимке, попыток нет). Кейса нет в снимке — нет ключа.
   */
  cases: Record<
    string,
    {
      version: number;
      status: string | null;
      /** Commit последней попытки (`attemptCodeSha`), IA-AB-04. */
      codeSha: string | null;
    }
  >;
}

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

@Injectable()
export class QaRunEvidenceReader {
  constructor(private readonly db: SitesDb) {}

  /** Версия кода этого процесса (IA-AB-04) — см. `releaseCodeSha`. */
  releaseSha(): string | null {
    return releaseCodeSha();
  }

  async runEvidence(
    accountId: string,
    runId: string,
  ): Promise<QaRunEvidenceView | null> {
    if (!RUN_ID.test(runId)) return null;
    const db = this.db.forAccount(accountId);
    return db.$transaction(
      async (tx) => {
        const run = await tx.qaTestRun.findFirst({
          where: { id: runId, accountId },
          select: {
            id: true,
            siteId: true,
            title: true,
            createdAt: true,
            snapshot: true,
          },
        });
        if (!run) return null;
        const heads = await tx.qaTestRunAttempt.groupBy({
          by: ['caseKey'],
          where: { accountId, runId },
          _max: { attemptNumber: true },
        });
        const latest = heads.length
          ? await tx.qaTestRunAttempt.findMany({
              where: {
                accountId,
                runId,
                OR: heads.map((h) => ({
                  caseKey: h.caseKey,
                  attemptNumber: h._max.attemptNumber!,
                })),
              },
              select: {
                caseKey: true,
                status: true,
                origin: true,
                sourceMetadata: true,
              },
            })
          : [];
        const cases: QaRunEvidenceView['cases'] = {};
        const snapshot = Array.isArray(run.snapshot) ? run.snapshot : [];
        for (const item of snapshot as Array<{
          caseKey?: unknown;
          version?: unknown;
        }>) {
          if (
            typeof item?.caseKey !== 'string' ||
            typeof item.version !== 'number'
          )
            continue;
          const attempt = latest.find((a) => a.caseKey === item.caseKey);
          cases[item.caseKey] = {
            version: item.version,
            status: attempt ? acceptanceStatus(attempt) : null,
            codeSha: attempt ? attemptCodeSha(attempt.sourceMetadata) : null,
          };
        }
        return {
          runId: run.id,
          siteId: run.siteId,
          title: run.title,
          createdAt: run.createdAt,
          cases,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
