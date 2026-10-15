import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGenerated } from './generated-contract';
import { mockTransition, checkStand, type StandRecord } from './stand-contract';
const source = () =>
  JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../../assist/src/lib/qa-reddit-mock.json'),
      'utf8',
    ),
  );
const contract = () => {
  const c = source();
  return parseGenerated(c, c.description);
};
function world() {
  const c = contract();
  let rows: StandRecord[] = [];
  const call = (
    entityId: string,
    method: string,
    args: object = {},
    role = 'admin',
  ) => {
    const r = mockTransition(c, rows, { entityId, method, role, ...args });
    rows = r.records;
    return r;
  };
  const community = call('communities', 'POST', {
    values: ['qa_saas', 'Synthetic policy', 'unreviewed', 'allowed'],
  }).records[0];
  const draft = call('drafts', 'POST', {
    values: [
      'QA post',
      'Synthetic text',
      'qa_saas',
      'draft',
      'pass',
      'pass',
      'active',
    ],
  }).records[1];
  const current = (id: string) => rows.find((r) => r.id === id)!;
  const transition = (
    entityId: string,
    id: string,
    transitionId: string,
    role = 'admin',
  ) =>
    call(
      entityId,
      'TRANSITION',
      { id, transitionId, expectedVersion: current(id).version },
      role,
    );
  return { c, call, community, draft, current, transition };
}
describe('declarative mock workflows', () => {
  it('blocks unreviewed rules, then approves and issues exactly the sealed values', () => {
    const w = world();
    expect(w.transition('drafts', w.draft.id, 'approve').status).toBe(409);
    expect(w.transition('communities', w.community.id, 'review').status).toBe(
      200,
    );
    expect(w.transition('drafts', w.draft.id, 'approve', 'editor').status).toBe(
      403,
    );
    expect(w.transition('drafts', w.draft.id, 'approve').status).toBe(200);
    const copy = w.transition('drafts', w.draft.id, 'copy', 'editor');
    expect(copy.status).toBe(200);
    expect((copy.data as StandRecord).values.slice(0, 3)).toEqual(
      w.draft.values.slice(0, 3),
    );
    expect(w.transition('drafts', w.draft.id, 'copy').status).toBe(409);
  });
  it('editing content resets approval; direct state assignment and stale edits are rejected', () => {
    const w = world();
    w.transition('communities', w.community.id, 'review');
    w.transition('drafts', w.draft.id, 'approve');
    const d = w.current(w.draft.id);
    const values = [...d.values];
    values[1] = 'Changed text';
    expect(
      w.call('drafts', 'PATCH', {
        id: d.id,
        values,
        expectedVersion: d.version,
      }).status,
    ).toBe(200);
    expect(w.current(d.id).values[3]).toBe('draft');
    expect(w.current(d.id).approvalDigest).toBeUndefined();
    expect(
      w.call('drafts', 'PATCH', {
        id: d.id,
        values,
        expectedVersion: d.version,
      }).status,
    ).toBe(409);
    values[3] = 'approved';
    expect(
      w.call('drafts', 'PATCH', {
        id: d.id,
        values,
        expectedVersion: w.current(d.id).version,
      }).status,
    ).toBe(422);
    expect(w.call('drafts', 'POST', { values }).status).toBe(422);
  });
  it('changed related policy invalidates approval even after re-review and restoring text', () => {
    const w = world();
    w.transition('communities', w.community.id, 'review');
    w.transition('drafts', w.draft.id, 'approve');
    let c = w.current(w.community.id);
    let values = [...c.values];
    values[1] = 'Changed policy';
    w.call('communities', 'PATCH', {
      id: c.id,
      values,
      expectedVersion: c.version,
    });
    w.transition('communities', c.id, 'review');
    c = w.current(c.id);
    values = [...c.values];
    values[1] = 'Synthetic policy';
    w.call('communities', 'PATCH', {
      id: c.id,
      values,
      expectedVersion: c.version,
    });
    w.transition('communities', c.id, 'review');
    expect(w.transition('drafts', w.draft.id, 'copy').status).toBe(409);
  });
  it('missing or ambiguous relationships and prohibited promotion fail closed', () => {
    const w = world();
    w.transition('communities', w.community.id, 'review');
    w.call('communities', 'POST', {
      values: ['qa_saas', 'duplicate', 'unreviewed', 'allowed'],
    });
    expect(w.transition('drafts', w.draft.id, 'approve').status).toBe(409);
    const v = world();
    const c = v.current(v.community.id);
    const values = [...c.values];
    values[3] = 'prohibited';
    v.call('communities', 'PATCH', {
      id: c.id,
      values,
      expectedVersion: c.version,
    });
    v.transition('communities', c.id, 'review');
    expect(v.transition('drafts', v.draft.id, 'approve').status).toBe(409);
    v.call('communities', 'DELETE', { id: c.id });
    expect(v.transition('drafts', v.draft.id, 'approve').status).toBe(409);
  });
  it('denies viewer edits, cross-entity IDs and arbitrary workflow definitions', () => {
    const w = world();
    expect(
      w.call(
        'drafts',
        'PATCH',
        { id: w.draft.id, expectedVersion: 1, values: w.draft.values },
        'viewer',
      ).status,
    ).toBe(403);
    expect(
      w.call('communities', 'PATCH', {
        id: w.draft.id,
        expectedVersion: 1,
        values: w.community.values,
      }).status,
    ).toBe(404);
    const s = source();
    s.workflows[1].transitions[0].conditions[0].related = {
      entityId: 'missing',
      viaField: 'Сообщество',
      matchField: 'Название',
    };
    expect(() => parseGenerated(s, s.description)).toThrow('workflow');
    const x = source();
    x.workflows[1].transitions[1].conditions = [];
    expect(() => parseGenerated(x, x.description)).toThrow('workflow');
  });
  it('preserves old contracts and validates the reusable Reddit preset', () => {
    const c = contract();
    expect(c.workflows).toHaveLength(2);
    c.entities[0].fields[2].options.reverse();
    expect(checkStand(c).checks.every((x) => x.passed)).toBe(true);
  });
});
