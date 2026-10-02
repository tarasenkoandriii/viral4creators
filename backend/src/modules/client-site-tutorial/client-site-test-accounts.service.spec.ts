/* eslint-disable @typescript-eslint/no-explicit-any -- дублёры Prisma и клиента */
/**
 * Экран «Тестовые учётные записи» мастера обучалки (Э-С Ш2): режим A —
 * реестр сайта, B — личные записи по сайту черновика; хранилище не
 * включено — честное «off»; чужой проект — 404; пароль только на запись.
 */
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SitesRejectedError } from '../sites-internal/sites-internal.client';
import {
  ClientSiteTestAccountsService,
  testAccountInput,
} from './client-site-test-accounts.service';

function make(opts: {
  draft?: Record<string, unknown> | null;
  project?: unknown;
  store?: boolean;
  telegramId?: string | null;
}) {
  const draft =
    opts.draft === undefined
      ? {
          id: 'd1',
          baseUrl: 'https://shop.example.com',
          siteMode: 'A',
          siteHostId: 'h1',
          siteTestAccountId: 'ta1',
          userSiteSessionId: null,
        }
      : opts.draft;
  const prisma = {
    project: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.project === undefined
            ? { id: 'p1', type: 'CLIENT_SITE' }
            : opts.project,
        ),
    },
    clientSiteTutorialDraft: {
      findUnique: jest.fn().mockResolvedValue(draft),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        telegramId: opts.telegramId === undefined ? '4242' : opts.telegramId,
      }),
    },
  } as any;
  const sites = {
    configured: jest.fn(() => true),
    listTestAccounts: jest.fn().mockResolvedValue({
      siteId: 's1',
      hosts: [{ id: 'h1', host: 'shop.example.com', verified: true }],
      accounts: [{ id: 'ta1', label: 'Обучалка' }],
    }),
    listUserSessions: jest.fn().mockResolvedValue({
      sessions: [
        { id: 'u1', origin: 'https://shop.example.com' },
        { id: 'u2', origin: 'https://other.example.com' },
      ],
    }),
    upsertTestAccount: jest.fn().mockResolvedValue({ id: 'ta2' }),
    updateUserSession: jest.fn().mockResolvedValue({ id: 'u1' }),
    deleteTestAccount: jest.fn().mockResolvedValue({ deleted: true }),
    deleteUserSession: jest.fn().mockResolvedValue({ deleted: true }),
  } as any;
  const svc = new ClientSiteTestAccountsService(prisma, sites);
  svc.env =
    opts.store === false ? {} : { SITE_TUTORIAL_CREDENTIALS_STORE: 'sites' };
  return { svc, prisma, sites };
}

describe('тестовые учётные записи мастера (Ш2)', () => {
  it('хранилище не включено — store: off, без похода в sites-backend', async () => {
    const { svc, sites } = make({ store: false });
    await expect(svc.view('u', 'p1')).resolves.toMatchObject({
      store: 'off',
      mode: 'A',
      hasDraft: true,
    });
    expect(sites.listTestAccounts).not.toHaveBeenCalled();
    await expect(svc.remove('u', 'p1', 'ta1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('режим A: реестр сайта по хосту черновика и хосты сайта', async () => {
    const { svc, sites } = make({});
    await expect(svc.view('u', 'p1')).resolves.toMatchObject({
      store: 'on',
      mode: 'A',
      accounts: [{ id: 'ta1' }],
      hosts: [{ id: 'h1' }],
      draftRecordId: 'ta1',
    });
    expect(sites.listTestAccounts).toHaveBeenCalledWith('4242', 'h1');
  });

  it('режим A, кабинет отказал (роль) — личные записи этого сайта', async () => {
    const { svc, sites } = make({});
    sites.listTestAccounts.mockRejectedValue(
      new SitesRejectedError(403, 'HOST_NOT_MANAGED', 'нет'),
    );
    const v = await svc.view('u', 'p1');
    expect(v.mode).toBe('B');
    expect(v.sessions.map((s) => s.id)).toEqual(['u1']);
  });

  it('режим B: только записи по сайту черновика; правка — только подпись', async () => {
    const { svc, sites } = make({
      draft: {
        id: 'd1',
        baseUrl: 'https://shop.example.com',
        siteMode: 'B',
        siteHostId: null,
        siteTestAccountId: null,
        userSiteSessionId: 'u1',
      },
    });
    const v = await svc.view('user7', 'p1');
    expect(v).toMatchObject({ mode: 'B', draftRecordId: 'u1' });
    expect(sites.listUserSessions).toHaveBeenCalledWith('gen:user7');
    await svc.update('user7', 'p1', 'u1', { label: 'Мой вход' });
    expect(sites.updateUserSession).toHaveBeenCalledWith(
      'gen:user7',
      'u1',
      'Мой вход',
    );
    await expect(
      svc.update('user7', 'p1', 'u1', { password: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create('user7', 'p1', { label: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('режим A: завести — хост черновика по умолчанию, продукт обучалка; пустой пароль не уходит', async () => {
    const { svc, sites } = make({});
    await svc.create('u', 'p1', {
      label: 'Админ',
      password: '',
      products: ['tutorial', 'qa'],
    });
    expect(sites.upsertTestAccount).toHaveBeenCalledWith('4242', {
      hostId: 'h1',
      account: {
        label: 'Админ',
        products: ['tutorial', 'qa'],
        hostIds: ['h1'],
      },
    });
  });

  it('«Забыть» запись этого черновика — ссылка в черновике обнулена', async () => {
    const { svc, sites, prisma } = make({});
    await svc.remove('u', 'p1', 'ta1');
    expect(sites.deleteTestAccount).toHaveBeenCalledWith('4242', 'ta1');
    expect(prisma.clientSiteTutorialDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { siteTestAccountId: null, storeHasCredentials: false },
    });
  });

  it('чужой проект — 404; лишнее поле — 400; отказ sites-backend — его код и статус', async () => {
    await expect(
      make({ project: null }).svc.view('u', 'p1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(() => testAccountInput({ secret: 1 })).toThrow(BadRequestException);
    const { svc, sites } = make({});
    sites.upsertTestAccount.mockRejectedValue(
      new SitesRejectedError(400, 'TEST_ACCOUNT_INVALID', 'кривой срок'),
    );
    await expect(
      svc.update('u', 'p1', 'ta1', { lifetimeDays: 365 }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
