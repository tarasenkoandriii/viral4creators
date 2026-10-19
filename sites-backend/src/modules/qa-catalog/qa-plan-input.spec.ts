import { parsePlan } from './qa-plan-input';
export const qaPlanFixture = () => ({
  title: 'Regression',
  suite: 'Onboarding',
  description: 'Demo accounts only',
  caseIds: ['case'],
  environments: [
    {
      name: 'Desktop RU',
      browser: 'Chromium',
      device: 'Desktop',
      theme: 'dark',
      locale: 'ru',
      viewport: '1280x720',
    },
  ],
  assigneeMemberId: null,
  archived: false,
});
describe('QA plan validation', () => {
  it('accepts a bounded, named environment matrix', () =>
    expect(parsePlan(qaPlanFixture()).environments).toHaveLength(1));
  it.each([
    { caseIds: [] },
    { caseIds: ['case', 'case'] },
    { environments: [] },
    { accountId: 'other' },
    { assigneeMemberId: '../x' },
    { archived: 'false' },
  ])('rejects invalid or caller owned fields %p', (extra) =>
    expect(() => parsePlan({ ...qaPlanFixture(), ...extra })).toThrow(),
  );
  it.each([
    { theme: 'unknown' },
    { locale: 'ru?token=secret' },
    { viewport: '9999x720' },
    { viewport: '0x0' },
    { browser: '' },
  ])('rejects invalid environment %p', (extra) =>
    expect(() =>
      parsePlan({
        ...qaPlanFixture(),
        environments: [{ ...qaPlanFixture().environments[0], ...extra }],
      }),
    ).toThrow(),
  );
});
