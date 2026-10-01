import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { REQUIRE_ASSIST_MANAGER } from '../../site-core/account/roles';
import {
  SiteWizardController,
  WizardAnswerDto,
  WizardStartDto,
} from './site-wizard.controller';

const m = { accountId: 'a' } as never;

function make() {
  const svc = {
    get: jest.fn(async () => 'get'),
    start: jest.fn(async () => 'start'),
    runDrafts: jest.fn(async () => 'drafts'),
    answer: jest.fn(async () => 'answer'),
    complete: jest.fn(async () => 'complete'),
    completeness: jest.fn(async () => 'completeness'),
  };
  return { svc, c: new SiteWizardController(svc as never) };
}

describe('SiteWizardController (маршруты мастера, контракт Э2 §6)', () => {
  it('права: assist = manager на всём контроллере', () => {
    const keys = Reflect.getMetadataKeys(SiteWizardController);
    const req = keys
      .map((k) => Reflect.getMetadata(k, SiteWizardController))
      .find((v) => v && typeof v === 'object' && 'assist' in v);
    expect(req).toEqual(REQUIRE_ASSIST_MANAGER);
  });

  it('пути и методы — по таблице контракта', () => {
    const p = SiteWizardController.prototype as unknown as Record<
      string,
      object
    >;
    const route = (name: string) => ({
      path: Reflect.getMetadata('path', p[name]),
      method: Reflect.getMetadata('method', p[name]),
    });
    expect(route('get')).toEqual({
      path: ':id/learning/site/onboarding',
      method: 0,
    });
    expect(route('start').path).toBe(':id/learning/site/onboarding/start');
    expect(route('drafts').path).toBe(':id/learning/site/onboarding/drafts');
    expect(route('answer')).toEqual({
      path: ':id/learning/site/onboarding/items/:topic',
      method: 4,
    });
    expect(route('complete').path).toBe(
      ':id/learning/site/onboarding/complete',
    );
    expect(route('completeness').path).toBe(':id/learning/site/completeness');
  });

  it('тема из пути — только из набора; тело передаётся как есть', async () => {
    const { c, svc } = make();
    await expect(
      c.answer(m, 's1', 'drop table', { status: 'skipped' } as never),
    ).rejects.toMatchObject({ response: { code: 'BAD_REQUEST' } });
    await c.answer(m, 's1', 'delivery', {
      status: 'edited',
      answer: 'x',
    } as WizardAnswerDto);
    expect(svc.answer).toHaveBeenCalledWith(m, 's1', 'delivery', {
      status: 'edited',
      answer: 'x',
    });
    await c.start(m, 's1', {} as WizardStartDto);
    expect(svc.start).toHaveBeenCalledWith(m, 's1', null);
  });

  it('DTO: тип бизнеса и статус — перечисления, ответ ≤ 5000', async () => {
    const bad = await validate(
      plainToInstance(WizardStartDto, { businessType: 'casino' }),
    );
    expect(bad).toHaveLength(1);
    expect(
      await validate(plainToInstance(WizardStartDto, { businessType: 'saas' })),
    ).toHaveLength(0);
    expect(
      await validate(plainToInstance(WizardAnswerDto, { status: 'saved' })),
    ).toHaveLength(1);
    expect(
      await validate(
        plainToInstance(WizardAnswerDto, {
          status: 'edited',
          answer: 'я'.repeat(5001),
        }),
      ),
    ).toHaveLength(1);
    expect(
      await validate(
        plainToInstance(WizardAnswerDto, { status: 'edited', answer: 'ок' }),
      ),
    ).toHaveLength(0);
  });
});
