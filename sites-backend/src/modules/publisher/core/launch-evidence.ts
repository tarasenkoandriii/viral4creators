/**
 * AI Publisher — доказательство приёмки в гейтах запуска (Р-PUB-Z2-27,
 * предаудит DEF-C-07 / B1-F-03; ТЗ §28, план v1.1 §13).
 *
 * `launch_evidence_d0.qaRunId` и `launch_evidence_purchase.qaRunId` — id
 * СОХРАНЁННОГО прогона qa-catalog (порт `QaRunEvidencePort`), а не
 * свободная строка. Утверждение параметра требует: прогон существует в
 * кабинете; в его снимке есть каждый кейс обязательного списка (D0 — 21
 * сценарий с меткой шлюза `D0`, закупка — 30 с меткой `Z`, каталог
 * `reports/qa/at-catalog.ts`) той версии, что в каталоге сейчас; статус
 * ПОСЛЕДНЕЙ попытки каждого — `passed`. Иначе 409 `PUB_CONFLICT
 * {reason, key, qaRunId, required, missing[]}` с перечнем недостающего.
 * Чистая функция; чтение прогона — в `ParametersService.decide`.
 *
 * Привязка к версии кода (внутренний аудит IA-AB-04, ТЗ §28 «предварительный
 * успешный тест не разрешает выпуск изменённой версии»): последняя попытка
 * каждого обязательного кейса удостоверяет commit (`codeSha` =
 * `deployedSha` ?? `testSourceSha` отчёта), и он должен совпасть с версией
 * кода, которую выпускает процесс (`releaseSha` порта: PUBLISHER_RELEASE_SHA
 * / VERCEL_GIT_COMMIT_SHA / GITHUB_SHA). Версия процесса неизвестна —
 * `code_version_unknown`; у кейса другой commit или его нет —
 * `qa_run_incomplete` с `problem: 'code_version'`. Решение, принятое по
 * прогону, при следующем выпуске само не отзывается (остаток B1-F-03):
 * новая версия — новый прогон и новое утверждение.
 */
import {
  AT_CATALOG,
  AT_CATALOG_VERSION,
  type AtGate,
} from '../reports/qa/at-catalog';
import type { QaRunEvidence } from './ports';

export const LAUNCH_EVIDENCE_GATES = {
  launch_evidence_d0: 'D0',
  launch_evidence_purchase: 'Z',
} as const satisfies Record<string, AtGate>;
export type LaunchEvidenceKey = keyof typeof LAUNCH_EVIDENCE_GATES;

export function isLaunchEvidenceKey(k: string): k is LaunchEvidenceKey {
  return Object.prototype.hasOwnProperty.call(LAUNCH_EVIDENCE_GATES, k);
}

/** Обязательный список шлюза: AT-ID каталога с его меткой. */
export function requiredAtIds(gate: AtGate): string[] {
  return AT_CATALOG.filter((c) => c.gates.includes(gate)).map((c) => c.id);
}

export interface LaunchEvidenceGap {
  caseKey: string;
  /**
   * `not_in_run` — кейса нет в снимке; `version` — другая версия; `status` —
   * не passed; `code_version` — попытка на другом commit (IA-AB-04).
   */
  problem: 'not_in_run' | 'version' | 'status' | 'code_version';
  status?: string | null;
  version?: number;
  expectedVersion?: number;
  /** commit попытки (`null` — не указан) и ожидаемый (`releaseSha`). */
  codeSha?: string | null;
  expectedSha?: string;
}

export type LaunchEvidenceCheck =
  | {
      ok: true;
      required: number;
      runId: string;
      siteId: string;
      releaseSha: string;
    }
  | {
      ok: false;
      reason: 'qa_run_not_found' | 'qa_run_incomplete' | 'code_version_unknown';
      required: number;
      missing: LaunchEvidenceGap[];
      /** Версия кода процесса (есть, когда известна). */
      releaseSha?: string | null;
    };

/**
 * `releaseSha` — версия кода, которую выпускает процесс (полный sha, нижний
 * регистр) или `null` — неизвестна (IA-AB-04).
 */
export function launchEvidenceCheck(
  key: LaunchEvidenceKey,
  run: QaRunEvidence | null,
  releaseSha: string | null,
): LaunchEvidenceCheck {
  const ids = requiredAtIds(LAUNCH_EVIDENCE_GATES[key]);
  if (!run)
    return {
      ok: false,
      reason: 'qa_run_not_found',
      required: ids.length,
      missing: [],
    };
  const release = releaseSha?.trim().toLowerCase() || null;
  if (!release || !/^[a-f0-9]{40}$/.test(release))
    return {
      ok: false,
      reason: 'code_version_unknown',
      required: ids.length,
      missing: [],
      releaseSha: null,
    };
  const missing: LaunchEvidenceGap[] = [];
  for (const id of ids) {
    const c = run.cases[id];
    if (!c) missing.push({ caseKey: id, problem: 'not_in_run' });
    else if (c.version !== AT_CATALOG_VERSION)
      missing.push({
        caseKey: id,
        problem: 'version',
        version: c.version,
        expectedVersion: AT_CATALOG_VERSION,
      });
    else if (c.status !== 'passed')
      missing.push({ caseKey: id, problem: 'status', status: c.status });
    else if ((c.codeSha ?? null)?.toLowerCase() !== release)
      missing.push({
        caseKey: id,
        problem: 'code_version',
        codeSha: c.codeSha ?? null,
        expectedSha: release,
      });
  }
  return missing.length
    ? {
        ok: false,
        reason: 'qa_run_incomplete',
        required: ids.length,
        missing,
        releaseSha: release,
      }
    : {
        ok: true,
        required: ids.length,
        runId: run.runId,
        siteId: run.siteId,
        releaseSha: release,
      };
}

/** id прогона из значения параметра (форма уже проверена схемой). */
export function qaRunIdOf(value: unknown): string | null {
  const v = (value ?? {}) as { qaRunId?: unknown };
  return typeof v.qaRunId === 'string' ? v.qaRunId : null;
}
