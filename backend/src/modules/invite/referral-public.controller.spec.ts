/**
 * Анонимные маршруты приглашений — «Условно бесплатный Lite» §5.1, §12.2,
 * этап 134.
 *
 * Оба открыты без идентичности, и проверяется здесь ровно то, чем
 * открытый маршрут опасен: что через него нельзя положить в нашу
 * таблицу чужое и что его отказ не становится ошибкой на экране.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ReferralPublicController } from './referral-public.controller';
import { InviteEventsDto } from './dto/referral.dto';
import type { ReferralService } from './referral.service';
import type { WizardTelemetryService } from '../wizard-guide/wizard-telemetry.service';
import { INVITE_EVENT_STEPS } from '../../common/referral';

function build() {
  const referrals = { registerVisit: jest.fn().mockResolvedValue(undefined) };
  const telemetry = { record: jest.fn().mockResolvedValue(1) };
  const controller = new ReferralPublicController(
    referrals as unknown as ReferralService,
    telemetry as unknown as WizardTelemetryService,
  );
  return { controller, referrals, telemetry };
}

describe('ReferralPublicController', () => {
  it('переход уходит в сервис как есть — нормализация его дело', async () => {
    const { controller, referrals } = build();
    await expect(controller.visit({ code: 'abcd2345' })).resolves.toEqual({
      ok: true,
    });
    expect(referrals.registerVisit).toHaveBeenCalledWith('abcd2345');
  });

  it('телеметрия пишется в сценарий кабинета, а не мастера', async () => {
    const { controller, telemetry } = build();
    await controller.events({ steps: ['cabinet', 'copy'] });
    expect(telemetry.record).toHaveBeenCalledWith([
      { scenario: 'invite', stepId: 'cabinet', kind: 'enter' },
      { scenario: 'invite', stepId: 'copy', kind: 'click' },
    ]);
  });

  it('вид события задаёт сервер, а не клиент', async () => {
    // Если бы вид приезжал с клиента, одно и то же действие приходило
    // бы то `enter`, то `click`, и сводка перестала бы складываться.
    const { controller, telemetry } = build();
    await controller.events({ steps: [...INVITE_EVENT_STEPS] });
    const kinds = telemetry.record.mock.calls[0][0].map(
      (e: { stepId: string; kind: string }) => [e.stepId, e.kind],
    );
    expect(kinds).toEqual([
      ['cabinet', 'enter'],
      ['copy', 'click'],
      ['share', 'click'],
      ['wall', 'enter'],
    ]);
  });

  it('чужой stepId не доезжает до таблицы', async () => {
    // Маршрут открытый: без закрытого списка писать в нашу таблицу мог
    // бы кто угодно и что угодно.
    const dto = plainToInstance(InviteEventsDto, {
      steps: ['cabinet', 'admin'],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('steps');
  });

  it('четыре известных значения проходят валидацию', async () => {
    const dto = plainToInstance(InviteEventsDto, {
      steps: [...INVITE_EVENT_STEPS],
    });
    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('упавшая телеметрия не роняет ответ', async () => {
    // Телеметрия — наблюдение за продуктом, а не часть пути человека.
    const { controller, telemetry } = build();
    telemetry.record.mockRejectedValueOnce(new Error('база молчит'));
    await expect(controller.events({ steps: ['wall'] })).resolves.toEqual({
      ok: true,
    });
  });
});
