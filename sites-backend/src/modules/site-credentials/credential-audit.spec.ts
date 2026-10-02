import {
  AuditRow,
  auditHash,
  verifyAuditChain,
} from './credential-audit.service';

function chain(n: number): AuditRow[] {
  const rows: AuditRow[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.UTC(2026, 9, 2, 12, 0, i));
    const e = {
      actor: `generator:${i}`,
      action: 'lease' as const,
      scope: 'A' as const,
      accountId: 'acc',
      subjectId: `ta${i}`,
      result: 'ok',
    };
    const hash = auditHash(prev, e, at);
    rows.push({ ...e, at, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

describe('цепочка журнала доступа', () => {
  it('целая цепочка проходит', () => {
    expect(verifyAuditChain(chain(5))).toEqual({ ok: true, firstBroken: null });
  });

  it('правка поля в середине — видна', () => {
    const rows = chain(5);
    rows[2] = { ...rows[2], result: 'denied:host' };
    expect(verifyAuditChain(rows)).toEqual({ ok: false, firstBroken: 2 });
  });

  it('удалённая строка в середине — видна', () => {
    const rows = chain(5);
    rows.splice(2, 1);
    expect(verifyAuditChain(rows)).toEqual({ ok: false, firstBroken: 2 });
  });

  it('хеш не зависит от отсутствующих полей null/undefined', () => {
    const at = new Date();
    const e = {
      actor: 'a',
      action: 'read' as const,
      scope: 'B' as const,
      result: 'ok',
    };
    expect(auditHash(null, e, at)).toBe(
      auditHash(null, { ...e, accountId: null, ownerRef: undefined }, at),
    );
  });
});
