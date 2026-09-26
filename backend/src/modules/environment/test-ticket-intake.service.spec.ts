import { TestTicketIntakeService } from './test-ticket-intake.service';
import { APP_ATTACHMENT_LIMIT } from '../../common/test-ticket';

const NOW = new Date('2026-09-26T12:00:00.000Z');

const ENV = {
  surface: 'TMA',
  deviceKind: 'PHONE',
  osFamily: 'ios',
  tgPlatform: 'ios',
  uiLocale: 'uk',
  appBuild: '2026.09.26-abc',
};

function build(
  over: {
    user?: Record<string, unknown> | null;
    session?: Record<string, unknown> | null;
    head?: { url: string; size: number } | null;
  } = {},
) {
  const user =
    over.user === undefined
      ? {
          id: 'u1',
          isTestUser: true,
          testAccessUntil: null,
          testerInvites: [{ id: 'inv1' }],
        }
      : over.user;
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    session: {
      findUnique: jest.fn().mockResolvedValue(over.session ?? null),
    },
    testTicket: {
      create: jest.fn().mockResolvedValue({ id: 't1', number: 21 }),
    },
  };
  const blob = {
    createUploadUrl: jest
      .fn()
      .mockResolvedValue({ uploadUrl: 'https://blob/put?sig=1' }),
    head: jest
      .fn()
      .mockResolvedValue(
        over.head === undefined
          ? { url: 'https://blob/users/u1/tickets/app-1', size: 4096 }
          : over.head,
      ),
  };
  return {
    service: new TestTicketIntakeService(prisma as never, blob as never),
    prisma,
    blob,
  };
}

describe('ссылка на загрузку вложения', () => {
  it('путь ложится под владельца, а не в свой префикс', async () => {
    // Метла обходит закрытый список областей: под собственным
    // префиксом эти файлы не подобрал бы никто.
    const { service, blob } = build();
    const res = await service.uploadUrl('42', {
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
    expect(res.pathname).toMatch(/^users\/u1\/tickets\/app-/);
    expect(blob.createUploadUrl.mock.calls[0][2]).toBe(APP_ATTACHMENT_LIMIT);
  });

  it('чужой тип файла не принимается', async () => {
    const { service } = build();
    await expect(
      service.uploadUrl('42', {
        mimeType: 'application/x-msdownload',
        sizeBytes: 10,
      }),
    ).rejects.toThrow(/снимок экрана/);
  });

  it('слишком большой файл отклоняется ДО загрузки', async () => {
    // Сказать об этом после того, как человек прождал загрузку, — самый
    // дорогой способ сообщить о потолке.
    const { service, blob } = build();
    await expect(
      service.uploadUrl('42', {
        mimeType: 'video/mp4',
        sizeBytes: APP_ATTACHMENT_LIMIT + 1,
      }),
    ).rejects.toThrow(/МБ/);
    expect(blob.createUploadUrl).not.toHaveBeenCalled();
  });

  it('не тестировщику ссылку не выдаём', async () => {
    const { service } = build({
      user: { id: 'u2', isTestUser: false, testerInvites: [] },
    });
    await expect(
      service.uploadUrl('42', { mimeType: 'image/png', sizeBytes: 10 }),
    ).rejects.toThrow(/Тестовый доступ/);
  });

  it('истёкший доступ — тоже отказ', async () => {
    const { service } = build({
      user: {
        id: 'u3',
        isTestUser: true,
        testAccessUntil: new Date(Date.now() - 1000),
        testerInvites: [],
      },
    });
    await expect(
      service.uploadUrl('42', { mimeType: 'image/png', sizeBytes: 10 }),
    ).rejects.toThrow(/Тестовый доступ/);
  });
});

describe('находка из мини-аппа', () => {
  const session = {
    id: 's1',
    userId: 'u1',
    data: { locale: 'de' },
    project: { type: 'GREETING_VIDEO' },
  };

  it('окружение снято в момент находки, а не «последнее известное»', async () => {
    // В этом и весь смысл второго входа.
    const { service, prisma } = build();
    await service.create(
      '42',
      { text: 'кнопка не нажимается', environment: ENV },
      NOW,
    );
    const data = prisma.testTicket.create.mock.calls[0][0].data;
    expect(data.envCapturedAt).toEqual(NOW);
    expect(data.source).toBe('APP');
    expect(data.uiLocale).toBe('uk');
    expect(data.inviteId).toBe('inv1');
  });

  it('сценарий и локаль ролика берутся с сессии, а не с клиента', async () => {
    // По ним фильтруют и группируют: значение, которое клиент может
    // прислать любым, в фильтре бесполезно.
    const { service, prisma } = build({ session });
    await service.create(
      '42',
      {
        text: 'субтитры съехали',
        sessionId: 's1',
        stepId: 'prompt',
        environment: ENV,
      },
      NOW,
    );
    const data = prisma.testTicket.create.mock.calls[0][0].data;
    expect(data.scenario).toBe('GREETING_VIDEO');
    expect(data.sessionLocale).toBe('de');
    expect(data.sessionId).toBe('s1');
    expect(data.stepId).toBe('prompt');
    expect(data.envKey).toBe('greeting_video:prompt:tma:ios:uk');
  });

  it('чужая сессия не прикладывается, но находку не теряет', async () => {
    // Терять текст находки из-за неверной ссылки было бы куда хуже.
    const { service, prisma } = build({
      session: { ...session, userId: 'somebody-else' },
    });
    await service.create(
      '42',
      { text: 'баг', sessionId: 's1', environment: ENV },
      NOW,
    );
    const data = prisma.testTicket.create.mock.calls[0][0].data;
    expect(data.sessionId).toBeNull();
    expect(data.scenario).toBeNull();
    expect(prisma.testTicket.create).toHaveBeenCalled();
  });

  it('неизвестная сессия — то же самое', async () => {
    const { service, prisma } = build({ session: null });
    await service.create(
      '42',
      { text: 'баг', sessionId: 'нет такой', environment: ENV },
      NOW,
    );
    expect(prisma.testTicket.create.mock.calls[0][0].data.sessionId).toBeNull();
  });

  it('ни текста, ни файла — отказ, а не пустая находка', async () => {
    const { service } = build();
    await expect(
      service.create('42', { text: '   ', environment: ENV }, NOW),
    ).rejects.toThrow(/Опишите/);
  });

  it('один файл без текста — законная находка', async () => {
    const { service, prisma } = build();
    await service.create(
      '42',
      {
        text: '',
        environment: ENV,
        attachments: [
          { pathname: 'users/u1/tickets/app-1', mimeType: 'image/png' },
        ],
      },
      NOW,
    );
    expect(
      prisma.testTicket.create.mock.calls[0][0].data.attachments,
    ).toHaveLength(1);
  });

  it('вложение подтверждается по факту, а не по слову клиента', async () => {
    // Ссылку выдали — файл ещё не загружен, и сорвавшийся PUT оставил
    // бы в тикете путь, по которому ничего нет.
    const { service, prisma } = build({ head: null });
    await service.create(
      '42',
      {
        text: 'вот',
        environment: ENV,
        attachments: [
          { pathname: 'users/u1/tickets/app-1', mimeType: 'image/png' },
        ],
      },
      NOW,
    );
    expect(prisma.testTicket.create.mock.calls[0][0].data.attachments).toEqual(
      [],
    );
  });

  it('чужой путь в теле не превращается во вложение', async () => {
    // Иначе в тикет можно положить ссылку на чужой файл в нашем же
    // хранилище. Папка ДРУГОГО тестировщика — тот самый случай, который
    // пропускала первая версия проверки (аудит этапа 160).
    const { service, prisma, blob } = build();
    await service.create(
      '42',
      {
        text: 'вот',
        environment: ENV,
        attachments: [
          { pathname: 'sessions/s9/original.mp4' },
          { pathname: 'users/u1/voices/v1/sample.webm' },
          { pathname: 'users/СОСЕД/tickets/app-1' },
        ],
      },
      NOW,
    );
    expect(prisma.testTicket.create.mock.calls[0][0].data.attachments).toEqual(
      [],
    );
    expect(blob.head).not.toHaveBeenCalled();
  });

  it('больше пяти вложений не берём', async () => {
    const { service, prisma } = build();
    await service.create(
      '42',
      {
        text: 'вот',
        environment: ENV,
        attachments: Array.from({ length: 9 }, (_, i) => ({
          pathname: `users/u1/tickets/app-${i}`,
          mimeType: 'image/png',
        })),
      },
      NOW,
    );
    expect(
      prisma.testTicket.create.mock.calls[0][0].data.attachments,
    ).toHaveLength(5);
  });

  it('без окружения находка всё равно заводится', async () => {
    // Старый клиент или отказавший сборщик — не повод терять текст.
    const { service, prisma } = build();
    await service.create('42', { text: 'баг' }, NOW);
    const data = prisma.testTicket.create.mock.calls[0][0].data;
    expect(data.env).toBeUndefined();
    expect(data.envKey).toBeNull();
    expect(data.envCapturedAt).toBeNull();
    expect(data.uiLocale).toBe('unknown');
  });
});
