import { compareForms } from './form-drift';
import { QaStandsService } from './qa-stands.module';
import { ConflictException } from '@nestjs/common';
const baseline = () => ({
  url: 'https://example.invalid/app',
  version: 'v1',
  fields: [
    { id: 'app_name', type: 'text', required: true, maxLength: 100 },
    {
      id: 'scope',
      type: 'select',
      required: false,
      options: ['read', 'write'],
    },
  ],
});
describe('form structural drift', () => {
  it('ignores order and version-only changes', () => {
    const b = baseline(),
      c = baseline();
    c.version = 'v2';
    c.fields.reverse();
    c.fields[0].options?.reverse();
    expect(compareForms({ baseline: b, current: c }).blocked).toBe(false);
  });
  it('detects added, removed and changed constraints', () => {
    const b = baseline(),
      c = baseline();
    c.fields[0].required = false;
    c.fields[0].maxLength = 50;
    c.fields.pop();
    c.fields.push({
      id: 'email',
      type: 'email',
      required: true,
      maxLength: 100,
    });
    const r = compareForms({ baseline: b, current: c });
    expect(r.blocked).toBe(true);
    expect(r.changes).toEqual([
      'changed:app_name:required',
      'changed:app_name:maxLength',
      'removed:scope',
      'added:email',
    ]);
    expect(r.baselineHash).not.toBe(r.currentHash);
  });
  it('rejects values, target changes and ambiguous keys', () => {
    const b = baseline();
    expect(() =>
      compareForms({ baseline: b, current: { ...b, values: ['secret'] } }),
    ).toThrow();
    expect(() =>
      compareForms({
        baseline: b,
        current: { ...b, url: 'https://other.invalid/app' },
      }),
    ).toThrow();
    expect(() =>
      compareForms({
        baseline: b,
        current: { ...b, url: b.url + '?token=secret' },
      }),
    ).toThrow();
    expect(() =>
      compareForms({
        baseline: b,
        current: { ...b, fields: [b.fields[0], b.fields[0]] },
      }),
    ).toThrow();
    expect(() =>
      compareForms({
        baseline: b,
        current: { ...b, fields: [{ ...b.fields[0], value: 'secret' }] },
      }),
    ).toThrow();
  });
  it('creates a scoped finding and resolves duplicates', async () => {
    const db = {
      qaStand: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'stand', contract: { version: 2 } }),
      },
    };
    const catalog = { scoped: jest.fn().mockResolvedValue(db) };
    const findings = {
      create: jest
        .fn<Promise<{ id: string }>, [unknown, unknown, unknown]>()
        .mockResolvedValue({ id: 'finding' }),
    };
    const service = new QaStandsService(
      { forAccount: () => db } as never,
      catalog as never,
      findings as never,
    );
    const m = { accountId: 'a', memberId: 'm' } as never,
      c = baseline();
    c.fields[0].required = false;
    const input = { baseline: baseline(), current: c };
    expect(await service.compareForm(m, 'site', 'stand', input)).toMatchObject({
      blocked: true,
      findingId: 'finding',
      duplicate: false,
      fillAvailable: false,
    });
    expect(catalog.scoped).toHaveBeenCalledWith(m, 'site', true);
    findings.create.mockRejectedValue(
      new ConflictException({
        code: 'QA_FINDING_DUPLICATE',
        details: { findingId: 'finding' },
      }),
    );
    expect(await service.compareForm(m, 'site', 'stand', input)).toMatchObject({
      findingId: 'finding',
      duplicate: true,
    });
    findings.create.mockClear();
    expect(
      await service.compareForm(m, 'site', 'stand', {
        baseline: baseline(),
        current: baseline(),
      }),
    ).toMatchObject({ blocked: false, findingId: null, fillAvailable: false });
    expect(findings.create).not.toHaveBeenCalled();
  });
});
