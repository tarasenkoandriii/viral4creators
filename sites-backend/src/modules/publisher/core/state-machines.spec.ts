/**
 * Машины состояний (P-A1, проектный документ §7, §3.2): полный перебор
 * пар (from, to) каждой машины — разрешены ровно перечисленные; режим
 * продукта ≡ триггеру `pub_products_guard`; роли строки; ответ 409/403.
 */
import { PubError } from './errors';
import {
  APPROVAL_MACHINE,
  CONTENT_MACHINE,
  LEAD_MACHINE,
  MACHINES,
  PARAMETER_MACHINE,
  PLACEMENT_MACHINE,
  PRODUCT_MODE_MACHINE,
  PUBLICATION_MACHINE,
  REVIEW_TASK_MACHINE,
  allowedFrom,
  assertTransition,
  canTransition,
  type Machine,
} from './state-machines';

/** Ожидаемые переходы — дословно таблицы §7 (через «→»). */
const EXPECTED: Record<string, string[]> = {
  product_mode: [
    'closed→test',
    'test→closed',
    'closed→live',
    'test→live',
    'live→closed',
  ],
  content: [
    'brief→drafting',
    'drafting→editorial_review',
    'editorial_review→changes_requested',
    'changes_requested→drafting',
    'editorial_review→approved',
    'approved→drafting',
    'approved→scheduled',
    'scheduled→published',
    'scheduled→approved',
    'published→correction_required',
    'revised→correction_required',
    'correction_required→drafting',
    'correction_required→revised',
    'correction_required→published',
    'published→published',
    'revised→published',
    ...[
      'brief',
      'drafting',
      'editorial_review',
      'changes_requested',
      'approved',
      'scheduled',
      'published',
      'correction_required',
      'revised',
    ].map((s) => `${s}→withdrawn`),
  ],
  venue: [
    'candidate→verified',
    'candidate→rejected',
    'verified→rejected',
    'verified→candidate',
  ],
  placement: [
    'proposed→approved',
    'approved→budget_reserved',
    'budget_reserved→ordered',
    'ordered→publication_pending',
    'publication_pending→published',
    'published→verified_complete',
    'proposed→rejected',
    'approved→rejected',
    'budget_reserved→cancelled',
    'ordered→cancelled',
    'publication_pending→cancelled',
    'ordered→disputed',
    'publication_pending→disputed',
    'published→disputed',
    'disputed→publication_pending',
    'disputed→published',
    'disputed→cancelled',
  ],
  placement_payment: [
    'unpaid→pending',
    'unpaid→unknown',
    'pending→unknown',
    'pending→paid',
    'unknown→paid',
    'pending→unpaid',
    'unknown→unpaid',
    'paid→refunded',
  ],
  lead: [
    'new→contacted',
    'new→qualified',
    'contacted→qualified',
    'new→rejected',
    'contacted→rejected',
    'qualified→proposal_sent',
    'proposal_sent→won',
    'proposal_sent→lost',
    'rejected→contacted',
    'lost→contacted',
    'qualified→contacted',
  ],
  approval: [
    'active→revoked',
    'active→expired',
    'active→superseded',
    'active→consumed',
  ],
  review_task: ['open→resolved', 'open→dismissed'],
  distribution_action: [
    'planned→blocked',
    'planned→done',
    'planned→cancelled',
    'blocked→planned',
  ],
  publication: [
    'pending→published',
    'pending→failed',
    'published→replaced',
    'pending→withdrawn',
    'published→withdrawn',
  ],
  experiment: [
    'registered→running',
    'running→concluded',
    'registered→cancelled',
    'running→cancelled',
    'registered→superseded',
    'running→superseded',
    'concluded→superseded',
    'cancelled→superseded',
  ],
  integration: [
    'connected→degraded',
    'connected→disconnected',
    'degraded→connected',
    'degraded→disconnected',
    'disconnected→connected',
    'disconnected→degraded',
  ],
  ai_task: ['needs_human→open', 'open→done', 'open→needs_human'],
  ai_call: [
    'ok',
    'schema_invalid',
    'timeout',
    'unavailable',
    'empty',
    'truncated',
    'refused',
  ].map((s) => `running→${s}`),
  parameter: [
    'assumption→approved',
    'assumption→rejected',
    'approved→approved',
    'approved→revoked',
    'rejected→approved',
    'revoked→approved',
    'assumption→assumption',
    'rejected→assumption',
    'revoked→assumption',
  ],
  parameter_proposal: ['open→accepted', 'open→rejected', 'open→withdrawn'],
};

function allowedPairs(m: Machine<string>): string[] {
  const out: string[] = [];
  for (const f of m.states)
    for (const t of m.states) if (canTransition(m, f, t)) out.push(`${f}→${t}`);
  return out.sort();
}

describe('state-machines: перебор всех пар (§7)', () => {
  it('каждая машина из списка проверена', () => {
    expect(Object.keys(MACHINES).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [name, m] of Object.entries(MACHINES)) {
    it(`${name}: разрешены ровно перечисленные пары`, () => {
      expect(allowedPairs(m as Machine<string>)).toEqual(
        [...EXPECTED[name]].sort(),
      );
    });
  }

  it('у каждого перехода есть роли; статусы — из закрытых списков', () => {
    for (const m of Object.values(MACHINES) as Array<Machine<string>>) {
      for (const t of m.transitions) {
        expect(t.roles.length).toBeGreaterThan(0);
        expect(m.states).toContain(t.from);
        expect(m.states).toContain(t.to);
      }
      for (const s of m.initial) expect(m.states).toContain(s);
    }
  });

  it('режим продукта ≡ триггеру pub_products_guard (closed↔test, closed|test→live, live→closed)', () => {
    expect(allowedPairs(PRODUCT_MODE_MACHINE as Machine<string>)).toEqual([
      'closed→live',
      'closed→test',
      'live→closed',
      'test→closed',
      'test→live',
    ]);
    expect(
      PRODUCT_MODE_MACHINE.transitions.every((t) => t.roles.join() === 'admin'),
    ).toBe(true);
  });

  it('assertTransition: недопустимый — 409 PUB_TRANSITION_INVALID {from,to,allowed}; роль вне строки — 403', () => {
    let err: unknown = null;
    try {
      assertTransition(APPROVAL_MACHINE, 'revoked', 'active');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PubError);
    expect((err as PubError).getStatus()).toBe(409);
    expect((err as PubError).details).toEqual({
      machine: 'approval',
      from: 'revoked',
      to: 'active',
      allowed: [],
    });
    expect(() =>
      assertTransition(LEAD_MACHINE, 'new', 'qualified', {
        actors: ['editor'],
      }),
    ).toThrow(expect.objectContaining({ code: 'PUB_ROLE_REQUIRED' }));
    expect(
      assertTransition(LEAD_MACHINE, 'new', 'qualified', { actors: ['sales'] })
        .action,
    ).toBe('qualify');
    expect(allowedFrom(REVIEW_TASK_MACHINE, 'open').sort()).toEqual([
      'dismissed',
      'resolved',
    ]);
  });

  it('ключевые правила §7: согласование — только PO; закупка — согласует только PO; AI не участник машин', () => {
    expect(
      assertTransition(CONTENT_MACHINE, 'editorial_review', 'approved').roles,
    ).toEqual(['product_owner']);
    expect(
      assertTransition(PLACEMENT_MACHINE, 'proposed', 'approved').roles,
    ).toEqual(['product_owner']);
    expect(
      assertTransition(PARAMETER_MACHINE, 'assumption', 'approved').roles,
    ).toEqual(['product_owner']);
    for (const m of Object.values(MACHINES) as Array<Machine<string>>) {
      for (const t of m.transitions)
        expect(t.roles).not.toContain('ai' as never);
    }
    // опубликованная публикация не «возвращается» в pending
    expect(canTransition(PUBLICATION_MACHINE, 'published', 'pending')).toBe(
      false,
    );
  });
});
