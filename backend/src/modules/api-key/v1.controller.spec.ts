jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { V1Controller } from './v1.controller';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { lastValueFrom, of } from 'rxjs';

/**
 * Этап 144 после аудита. Внешний контракт: что именно увидит чужой код.
 */
function build() {
  const plans = {
    budgetOf: jest.fn().mockResolvedValue({
      plan: 'PREMIUM',
      limitMicroUsd: 100_000_000,
      spentMicroUsd: 12_500_000,
      remainingMicroUsd: 87_500_000,
    }),
  };
  const jobs = {
    submit: jest.fn(),
    get: jest.fn(),
  };
  return {
    controller: new V1Controller(plans as never, jobs as never),
    plans,
    jobs,
  };
}

const req = { telegramUserId: 'u1', apiKeyId: 'k1' } as never;

describe('V1Controller.me', () => {
  it('отдаёт режим, потолок и ключ, которым вошли', async () => {
    const { controller } = build();
    await expect(controller.me(req)).resolves.toEqual({
      plan: 'PREMIUM',
      budget: {
        limitMicroUsd: 100_000_000,
        spentMicroUsd: 12_500_000,
        remainingMicroUsd: 87_500_000,
      },
      apiKeyId: 'k1',
    });
  });

  it('суточный потолок в ответе есть — это второй вопрос интегратора', async () => {
    // Первый — «работает ли ключ», второй — «сколько можно потратить».
    // Молчать о потолке значит дать узнать о нём по 403 посреди боя.
    const { controller } = build();
    const me = await controller.me(req);
    expect(me.budget.remainingMicroUsd).toBeGreaterThan(0);
  });

  it('поля «заблокирован» нет: оно не могло бы стать true никогда', async () => {
    // Заблокированный аккаунт до обработчика не доходит — гвард
    // отказывает раньше. Поле, которое всегда `false`, это ветка в
    // чужом коде, которая не выполнится ни разу (аудит этапа 144).
    const { controller } = build();
    expect(await controller.me(req)).not.toHaveProperty('blocked');
  });
});

describe('внешний контракт: конверт ответа', () => {
  it('наружу уходит `data` внутри конверта, а не голый объект', async () => {
    // Это не деталь реализации, а публичный контракт `/v1`: интегратор
    // пишет `res.data.plan`. Держится он глобальной регистрацией в
    // `main.ts`, и снять её «для порядка» — значит молча сломать чужие
    // интеграции; шов в `check-docs` сторожит именно это.
    const { controller } = build();
    const me = await controller.me(req);

    const wrapped = await lastValueFrom(
      new ResponseInterceptor().intercept(
        {} as never,
        {
          handle: () => of(me),
        } as never,
      ),
    );

    expect(wrapped.success).toBe(true);
    expect(wrapped.data).toEqual(me);
    // `requestId` — тот самый номер, с которым интегратор придёт в
    // поддержку; без него разбирать чужой отказ не по чему.
    expect(wrapped.meta.requestId).toEqual(expect.any(String));
  });
});

/**
 * Этап 145. `POST /v1/videos` — заказ ролика.
 */
describe('V1Controller.createVideo', () => {
  const res = () => {
    const status = jest.fn();
    return { res: { status } as never, status };
  };
  const job = {
    jobId: 'job-1',
    status: 'QUEUED' as const,
    videoUrl: null,
    error: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
  };

  it('новая заявка остаётся 202 — маршрут кода не трогает', async () => {
    const { controller, jobs } = build();
    jobs.submit.mockResolvedValue({ job, repeated: false });
    const r = res();

    await expect(
      controller.createVideo(
        req,
        { productItemId: 'i', libraryEntryId: 'l' },
        undefined,
        r.res,
      ),
    ).resolves.toEqual(job);

    expect(r.status).not.toHaveBeenCalled();
  });

  it('повтор отвечает 200, а не 202', async () => {
    // Разные коды не украшение: по ним чужой код отличает «приняли» от
    // «уже принимали», и без этой разницы повтор после таймаута
    // выглядит как вторая генерация, за которую сейчас спишут.
    const { controller, jobs } = build();
    jobs.submit.mockResolvedValue({ job, repeated: true });
    const r = res();

    await controller.createVideo(
      req,
      { productItemId: 'i', libraryEntryId: 'l' },
      ' idem-1 ',
      r.res,
    );

    expect(r.status).toHaveBeenCalledWith(200);
  });

  it('ключ повтора приходит заголовком и очищается от пробелов', async () => {
    const { controller, jobs } = build();
    jobs.submit.mockResolvedValue({ job, repeated: false });
    await controller.createVideo(
      req,
      { productItemId: 'i', libraryEntryId: 'l' },
      ' idem-1 ',
      res().res,
    );
    expect(jobs.submit.mock.calls[0][3]).toBe('idem-1');
  });

  it('пустой заголовок — это отсутствие ключа, а не ключ из пустоты', async () => {
    // Пустая строка нашла бы в базе первую заявку без ключа.
    const { controller, jobs } = build();
    jobs.submit.mockResolvedValue({ job, repeated: false });
    await controller.createVideo(
      req,
      { productItemId: 'i', libraryEntryId: 'l' },
      '   ',
      res().res,
    );
    expect(jobs.submit.mock.calls[0][3]).toBeNull();
  });

  it('заявка подаётся от хозяина ключа и помнит, каким ключом', async () => {
    const { controller, jobs } = build();
    jobs.submit.mockResolvedValue({ job, repeated: false });
    await controller.createVideo(
      req,
      { productItemId: 'i', libraryEntryId: 'l' },
      undefined,
      res().res,
    );
    expect(jobs.submit.mock.calls[0][0]).toBe('u1');
    expect(jobs.submit.mock.calls[0][1]).toBe('k1');
  });
});
