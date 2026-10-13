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
  /** `not_in_run` — кейса нет в снимке; `version` — другая версия; `status` — не passed. */
  problem: 'not_in_run' | 'version' | 'status';
  status?: string | null;
  version?: number;
  expectedVersion?: number;
}

export type LaunchEvidenceCheck =
  | { ok: true; required: number; runId: string; siteId: string }
  | {
      ok: false;
      reason: 'qa_run_not_found' | 'qa_run_incomplete';
      required: number;
      missing: LaunchEvidenceGap[];
    };

export function launchEvidenceCheck(
  key: LaunchEvidenceKey,
  run: QaRunEvidence | null,
): LaunchEvidenceCheck {
  const ids = requiredAtIds(LAUNCH_EVIDENCE_GATES[key]);
  if (!run)
    return {
      ok: false,
      reason: 'qa_run_not_found',
      required: ids.length,
      missing: [],
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
  }
  return missing.length
    ? { ok: false, reason: 'qa_run_incomplete', required: ids.length, missing }
    : { ok: true, required: ids.length, runId: run.runId, siteId: run.siteId };
}

/** id прогона из значения параметра (форма уже проверена схемой). */
export function qaRunIdOf(value: unknown): string | null {
  const v = (value ?? {}) as { qaRunId?: unknown };
  return typeof v.qaRunId === 'string' ? v.qaRunId : null;
}
