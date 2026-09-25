jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ApiWebhookService } from './api-webhook.service';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signWebhook,
} from '../../common/api-webhook';

/**
 * Этап 146. Доставка исхода заявки: подпись, повторы, журнал.
 */
const VIEW = {
  jobId: 'job-1',
  status: 'DONE' as const,
  videoUrl: 'https://blob.test/v.mp4',
  error: null,
  createdAt: '2026-09-25T10:00:00.000Z',
  updatedAt: '2026-09-25T10:05:00.000Z',
};

const delivery = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  jobId: 'job-1',
  url: 'https://hooks.example.com/v4c',
  attempts: 0,
  ...over,
});

function build(
  over: {
    due?: Record<string, unknown>[];
    webhookUrl?: string | null;
    claimed?: boolean;
    job?: Record<string, unknown> | null;
    key?: Record<string, unknown> | null;
  } = {},
) {
  const updates: Record<string, unknown>[] = [];
  const prisma = {
    apiVideoJob: {
      findUnique: jest.fn().mockResolvedValue(
        'job' in over
          ? over.job
          : {
              id: 'job-1',
              apiKeyId: 'k1',
              status: 'DONE',
              videoUrl: 'https://blob.test/v.mp4',
              error: null,
              createdAt: new Date('2026-09-25T10:00:00Z'),
              updatedAt: new Date('2026-09-25T10:05:00Z'),
            },
      ),
    },
    apiKey: {
      findUnique: jest.fn().mockResolvedValue(
        'key' in over
          ? over.key
          : {
              keyHash: 'key-hash',
              revokedAt: null,
              webhookUrl:
                'webhookUrl' in over
                  ? over.webhookUrl
                  : 'https://hooks.example.com/v4c',
            },
      ),
    },
    apiWebhookDelivery: {
      findMany: jest.fn().mockResolvedValue(over.due ?? []),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: over.claimed === false ? 0 : 1 }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return data;
      }),
    },
  };
  return {
    service: new ApiWebhookService(prisma as never),
    prisma,
    updates,
  };
}

describe('ApiWebhookService.enqueue', () => {
  it('без адреса на ключе доставку не заводят', async () => {
    const { service, prisma } = build({ webhookUrl: null });
    await expect(service.enqueue('u1', 'job-1', 'k1')).resolves.toBe(false);
    expect(prisma.apiWebhookDelivery.upsert).not.toHaveBeenCalled();
  });

  it('доставка одна на заявку — повторный заход не плодит вторую', async () => {
    // `upsert`, а не `create`: оборванный тик не должен падать на
    // уникальности и оставлять заявку без сообщения.
    const { service, prisma } = build();
    await service.enqueue('u1', 'job-1', 'k1');
    expect(prisma.apiWebhookDelivery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { jobId: 'job-1' } }),
    );
  });

  it('сбой постановки не роняет вызывающего', async () => {
    // Заявка уже закрыта; подвести её из-за вебхука — обмен плохого на
    // худшее.
    const { service, prisma } = build();
    prisma.apiWebhookDelivery.upsert.mockRejectedValue(new Error('база'));
    await expect(service.enqueue('u1', 'job-1', 'k1')).resolves.toBe(false);
  });
});

describe('ApiWebhookService.deliverDue', () => {
  const okFetch = () =>
    jest.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;

  it('подписывает тело и временем, и секретом', async () => {
    const { service } = build({ due: [delivery()] });
    const fetchMock = okFetch();
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    await service.deliverDue();

    const [url, init] = (fetchMock as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe('https://hooks.example.com/v4c');
    const headers = init.headers as Record<string, string>;
    const stamp = headers[TIMESTAMP_HEADER];
    expect(headers[SIGNATURE_HEADER]).toBe(
      signWebhook('key-hash', stamp, init.body as string),
    );
    // Тело — ровно то, что отдаёт опрос: чужому коду не нужны две
    // разные формы одного ответа.
    expect(JSON.parse(init.body as string)).toEqual(VIEW);
  });

  it('2xx закрывает доставку', async () => {
    const { service, updates } = build({ due: [delivery()] });
    (globalThis as { fetch: typeof fetch }).fetch = okFetch();

    const result = await service.deliverDue();

    expect(result.delivered).toBe(1);
    expect(updates[0]).toMatchObject({ status: 'DELIVERED', attempts: 1 });
    expect(updates[0].deliveredAt).toBeInstanceOf(Date);
  });

  it('5xx откладывается с удваивающейся паузой', async () => {
    const { service, updates } = build({ due: [delivery()] });
    (globalThis as { fetch: typeof fetch }).fetch = jest
      .fn()
      .mockResolvedValue({ status: 503 }) as unknown as typeof fetch;

    const result = await service.deliverDue();

    expect(result.retried).toBe(1);
    expect(updates[0]).toMatchObject({ attempts: 1, lastStatusCode: 503 });
    expect(updates[0].nextAttemptAt).toBeInstanceOf(Date);
  });

  it('4xx не повторяется: повтор пришлёт то же самое', async () => {
    const { service, updates } = build({ due: [delivery()] });
    (globalThis as { fetch: typeof fetch }).fetch = jest
      .fn()
      .mockResolvedValue({ status: 400 }) as unknown as typeof fetch;

    const result = await service.deliverDue();

    expect(result.gaveUp).toBe(1);
    expect(updates[0]).toMatchObject({ status: 'FAILED', nextAttemptAt: null });
  });

  it('сетевая осечка повторяется', async () => {
    const { service, updates } = build({ due: [delivery()] });
    (globalThis as { fetch: typeof fetch }).fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;

    await service.deliverDue();

    expect(updates[0].nextAttemptAt).toBeInstanceOf(Date);
    expect(updates[0].lastError).toBe('ECONNRESET');
  });

  it('исчерпанные попытки закрывают доставку насовсем', async () => {
    const { service, updates } = build({ due: [delivery({ attempts: 2 })] });
    (globalThis as { fetch: typeof fetch }).fetch = jest
      .fn()
      .mockResolvedValue({ status: 500 }) as unknown as typeof fetch;

    await service.deliverDue();

    expect(updates[0]).toMatchObject({ status: 'FAILED', nextAttemptAt: null });
  });

  it('строка захватывается ДО сетевого вызова', async () => {
    // Иначе параллельный тик отправит второй раз, и чужая сторона
    // получит дубль без способа отличить его от нового исхода.
    const { service } = build({ due: [delivery()], claimed: false });
    const fetchMock = okFetch();
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    await service.deliverDue();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('пропавшая заявка закрывает доставку, а не крутит её вечно', async () => {
    const { service, updates } = build({ due: [delivery()], job: null });
    const fetchMock = okFetch();
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const result = await service.deliverDue();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.gaveUp).toBe(1);
    expect(updates[0]).toMatchObject({ status: 'FAILED' });
  });

  it('ОТОЗВАННЫЙ ключ останавливает доставку (аудит этапа 146)', async () => {
    // Ключ отзывают, когда он утёк. Адрес вебхука стоит на ключе —
    // поставить его мог тот, кто ключом завладел, а подпись он
    // проверит хешем известного ему ключа. «Отозвать» должно означать
    // «прекратится и то, что ключ привёл в движение».
    const { service, updates } = build({
      due: [delivery()],
      key: { keyHash: 'key-hash', revokedAt: new Date() },
    });
    const fetchMock = okFetch();
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const result = await service.deliverDue();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.gaveUp).toBe(1);
    expect(String(updates[0].lastError)).toMatch(/отозван/);
  });

  it('доставки идут ПАРАЛЛЕЛЬНО, а не по очереди', async () => {
    // У каждой свой таймаут в десять секунд: пять подряд это полсотни
    // секунд поверх фаз заявок, в том же тике — мимо таймаута функции.
    const { service } = build({
      due: [delivery({ id: 'd1' }), delivery({ id: 'd2', jobId: 'job-2' })],
    });
    let open = () => undefined as void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let started = 0;
    (globalThis as { fetch: typeof fetch }).fetch = jest.fn(async () => {
      if (++started === 2) open();
      await gate;
      return { status: 200 };
    }) as unknown as typeof fetch;

    const late = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('доставки пошли по очереди')),
        2000,
      ).unref?.(),
    );
    await Promise.race([service.deliverDue(), late]);

    expect(started).toBe(2);
  });
});
