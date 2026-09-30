/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
// Контроллер (ради его DTO) тянет сервисы с PrismaService — как в соседних спеках.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { SetPersonaLookQuotaDto } from './admin-panel.controller';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';
import {
  AdminPersonaLookQuotaSettingsService,
  isStoredQuota,
  isValidPersonaLookQuota,
} from './admin-persona-look-quota-settings.service';

function build(stored: Record<string, string> = {}) {
  const store = new Map(Object.entries(stored));
  const settings = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
  };
  return {
    svc: new AdminPersonaLookQuotaSettingsService(settings as any),
    settings,
    store,
  };
}

describe('AdminPersonaLookQuotaSettingsService (В-7)', () => {
  it('ничего не менялось — умолчания В-7', async () => {
    const v = await build().svc.view();
    expect(v.LITE).toEqual({
      day: { value: 3, defaultValue: 3, source: 'default' },
      month: { value: 20, defaultValue: 20, source: 'default' },
    });
    expect(v.STANDARD.day.value).toBe(10);
    expect(v.STANDARD.month.value).toBe(100);
    expect(v.PREMIUM.day.value).toBe(30);
    expect(v.PREMIUM.month.value).toBe(300);
  });

  it('заданное оператором читается тем же разбором, что и квота; мусор — умолчание', async () => {
    const v = await build({
      persona_look_day_lite: '0',
      persona_look_month_lite: 'abc',
      persona_look_day_premium: '45',
    }).svc.view();
    expect(v.LITE.day).toEqual({ value: 0, defaultValue: 3, source: 'admin' });
    expect(v.LITE.month).toEqual({
      value: 20,
      defaultValue: 20,
      source: 'default',
    });
    expect(v.PREMIUM.day.value).toBe(45);
  });

  it('запись: только присланное, в ключи квоты', async () => {
    const { svc, settings, store } = build();
    const v = await svc.set(
      { STANDARD: { day: 12 }, PREMIUM: { month: 0 } },
      'op',
    );
    expect(settings.set).toHaveBeenCalledTimes(2);
    expect(store.get('persona_look_day_standard')).toBe('12');
    expect(store.get('persona_look_month_premium')).toBe('0');
    expect(settings.set).toHaveBeenCalledWith(
      'persona_look_day_standard',
      '12',
      'op',
    );
    expect(v.STANDARD.day).toEqual({
      value: 12,
      defaultValue: 10,
      source: 'admin',
    });
  });

  it('границы: 0 и 1000 проходят; −1, 1001, дробь, не число — отказ без единой записи', async () => {
    const ok = build();
    await ok.svc.set({ LITE: { day: 0, month: 1000 } }, 'op');
    expect(ok.settings.set).toHaveBeenCalledTimes(2);
    for (const bad of [-1, 1001, 2.5, NaN, '5' as any]) {
      const { svc, settings } = build();
      await expect(
        svc.set({ LITE: { day: 1 }, STANDARD: { month: bad } }, 'op'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(settings.set).not.toHaveBeenCalled();
    }
    const { svc } = build();
    await expect(
      svc.set({ GOLD: { day: 1 } } as any, 'op'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.set({ LITE: { week: 1 } } as any, 'op'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('помощники разбора', () => {
    expect(isValidPersonaLookQuota(0)).toBe(true);
    expect(isValidPersonaLookQuota(1000)).toBe(true);
    expect(isValidPersonaLookQuota(1001)).toBe(false);
    expect(isValidPersonaLookQuota(-1)).toBe(false);
    expect(isStoredQuota('0')).toBe(true);
    expect(isStoredQuota('')).toBe(false);
    expect(isStoredQuota('1.5')).toBe(false);
    expect(isStoredQuota(null)).toBe(false);
  });
});

describe('SetPersonaLookQuotaDto (ValidationPipe)', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const run = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: SetPersonaLookQuotaDto });

  it('целые 0…1000 проходят', async () => {
    await expect(
      run({ LITE: { day: 0, month: 1000 }, PREMIUM: { day: 7 } }),
    ).resolves.toBeTruthy();
  });

  it('вне 0…1000, дробь, строка, лишний тариф — 400', async () => {
    for (const body of [
      { LITE: { day: -1 } },
      { LITE: { day: 1001 } },
      { STANDARD: { month: 1.5 } },
      { STANDARD: { month: '5' } },
      { GOLD: { day: 1 } },
      { LITE: { week: 1 } },
    ]) {
      await expect(run(body)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
