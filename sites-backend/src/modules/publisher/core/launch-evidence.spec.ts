/**
 * Р-PUB-Z2-26/27 (предаудит DEF-C-04, DEF-C-07 / B1-F-03): заглушка
 * уведомления о данных не утверждается и не открывает гейты; доказательство
 * приёмки — сохранённый прогон с обязательным списком шлюза (21/30) passed.
 */
import { DEFAULT_PARAMETER_VALUES } from '../contracts/parameters';
import { AT_CATALOG, AT_CATALOG_VERSION } from '../reports/qa/at-catalog';
import {
  launchEvidenceCheck,
  requiredAtIds,
  type LaunchEvidenceKey,
} from './launch-evidence';
import {
  parameterApprovalIssues,
  parameterPlaceholderIssues,
} from './parameter-schemas';
import type { QaRunEvidence } from './ports';
import { gateFlagsOf } from './refresh-gate-flags';
import { GATE_PARAMETER_KEYS } from '../contracts/parameters';

const REL = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const run = (
  status: (id: string) => string | null = () => 'passed',
  sha: (id: string) => string | null | undefined = () => REL,
): QaRunEvidence => ({
  runId: 'r1',
  siteId: 's1',
  title: 't',
  createdAt: new Date(),
  cases: Object.fromEntries(
    AT_CATALOG.map((c) => [
      c.id,
      { version: AT_CATALOG_VERSION, status: status(c.id), codeSha: sha(c.id) },
    ]),
  ),
});

describe('Р-PUB-Z2-27: доказательство приёмки в гейтах запуска', () => {
  it('обязательные списки §13 плана: D0 — 21 сценарий, закупка — 30, объединение — 32', () => {
    const d0 = requiredAtIds('D0');
    const z = requiredAtIds('Z');
    expect(d0).toHaveLength(21);
    expect(z).toHaveLength(30);
    expect(new Set([...d0, ...z]).size).toBe(32);
    expect(d0).toEqual(
      expect.arrayContaining(['AT-CORE-01', 'AT-CORE-22', 'AT-F11-02']),
    );
    expect(z).toEqual(expect.arrayContaining(['AT-CORE-18', 'AT-F12-02']));
    expect(d0).not.toContain('AT-CORE-08');
  });

  it('нет прогона — qa_run_not_found; всё passed — ok; иначе — перечень недостающего', () => {
    for (const key of [
      'launch_evidence_d0',
      'launch_evidence_purchase',
    ] as LaunchEvidenceKey[]) {
      expect(launchEvidenceCheck(key, null, REL)).toMatchObject({
        ok: false,
        reason: 'qa_run_not_found',
      });
      expect(launchEvidenceCheck(key, run(), REL)).toMatchObject({ ok: true });
    }
    // Упал сценарий, нужный только закупке: D0 открыт, закупка — нет.
    const r = run((id) => (id === 'AT-CORE-14' ? 'failed' : 'passed'));
    expect(launchEvidenceCheck('launch_evidence_d0', r, REL).ok).toBe(true);
    expect(launchEvidenceCheck('launch_evidence_purchase', r, REL)).toEqual({
      ok: false,
      reason: 'qa_run_incomplete',
      required: 30,
      missing: [{ caseKey: 'AT-CORE-14', problem: 'status', status: 'failed' }],
      releaseSha: REL,
    });
    // blocked/skipped — не passed.
    const b = run((id) => (id === 'AT-CORE-01' ? 'blocked' : 'passed'));
    expect(launchEvidenceCheck('launch_evidence_d0', b, REL).ok).toBe(false);
  });
});

describe('IA-AB-04: доказательство привязано к выпускаемой версии кода (ТЗ §28)', () => {
  it('прогон на старом commit (все passed) — отказ code_version по каждому кейсу; на текущем — ok', () => {
    const old = run(undefined, () => OLD);
    const d0 = launchEvidenceCheck('launch_evidence_d0', old, REL);
    expect(d0).toMatchObject({
      ok: false,
      reason: 'qa_run_incomplete',
      required: 21,
      releaseSha: REL,
    });
    expect(d0.ok ? [] : d0.missing).toHaveLength(21);
    expect(d0.ok ? null : d0.missing[0]).toEqual({
      caseKey: requiredAtIds('D0')[0],
      problem: 'code_version',
      codeSha: OLD,
      expectedSha: REL,
    });
    expect(launchEvidenceCheck('launch_evidence_d0', old, OLD).ok).toBe(true);
    // регистр sha не важен
    expect(
      launchEvidenceCheck('launch_evidence_d0', run(), REL.toUpperCase()).ok,
    ).toBe(true);
  });

  it('один кейс перепрогнан на другом commit или без sha (ручной/старый отчёт) — отказ именно по нему', () => {
    const mixed = run(undefined, (id) =>
      id === 'AT-CORE-01' ? OLD : id === 'AT-CORE-22' ? null : REL,
    );
    const c = launchEvidenceCheck('launch_evidence_d0', mixed, REL);
    expect(c.ok ? [] : c.missing).toEqual([
      {
        caseKey: 'AT-CORE-01',
        problem: 'code_version',
        codeSha: OLD,
        expectedSha: REL,
      },
      {
        caseKey: 'AT-CORE-22',
        problem: 'code_version',
        codeSha: null,
        expectedSha: REL,
      },
    ]);
    // порт без поля codeSha (старая форма) — тоже отказ
    const legacy = run(undefined, () => undefined);
    expect(
      launchEvidenceCheck('launch_evidence_purchase', legacy, REL).ok,
    ).toBe(false);
  });

  it('версия выпускаемого кода неизвестна или не полный sha — code_version_unknown, даже при полном passed', () => {
    for (const rel of [null, '', 'main', 'abc123'])
      expect(
        launchEvidenceCheck('launch_evidence_d0', run(), rel),
      ).toMatchObject({ ok: false, reason: 'code_version_unknown' });
  });
});

describe('Р-PUB-Z2-26: заглушка уведомления о данных', () => {
  const d = DEFAULT_PARAMETER_VALUES.data_notice_version;
  it('умолчание и любой «draft-…»/«Чернетка…» не утверждаются; реальный текст — да', () => {
    expect(parameterApprovalIssues('data_notice_version', d)).toEqual([
      { field: 'value.version', code: 'draft_placeholder' },
      { field: 'value.text', code: 'draft_placeholder' },
    ]);
    expect(
      parameterApprovalIssues('data_notice_version', {
        version: 'draft-2',
        text: 'Ми обробляємо дані заявки для відповіді.',
      }),
    ).toEqual([{ field: 'value.version', code: 'draft_placeholder' }]);
    expect(
      parameterApprovalIssues('data_notice_version', {
        version: 'v1',
        text: 'Чернетка: ще не затверджено',
      }),
    ).toEqual([{ field: 'value.text', code: 'draft_placeholder' }]);
    expect(
      parameterApprovalIssues('data_notice_version', {
        version: 'notice-v1',
        text: 'Ми обробляємо дані заявки для відповіді.',
      }),
    ).toEqual([]);
    // Только этот ключ — заглушка.
    expect(parameterPlaceholderIssues('niche', { text: 'Чернетка' })).toEqual(
      [],
    );
  });

  it('флаги гейтов: утверждённая (до правила) заглушка не открывает public_publish/real_leads', () => {
    const all = new Map(
      GATE_PARAMETER_KEYS.real_leads.map((k) => [k, 'approved'] as const),
    );
    expect(gateFlagsOf(all)).toEqual({
      paramsPublicPublishOk: true,
      paramsRealLeadsOk: true,
    });
    expect(gateFlagsOf(all, new Set(['data_notice_version']))).toEqual({
      paramsPublicPublishOk: false,
      paramsRealLeadsOk: false,
    });
  });
});
