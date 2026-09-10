import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PublishingChannelService } from './publishing-channel.service';
import { signOAuthState } from './oauth-state.util';
import { encryptToken } from '../../common/token-crypto';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({ publishing: { channelTokenKey: TOKEN_KEY } }),
}));

const plansMock = () => ({
  assertUser: jest.fn().mockResolvedValue(undefined),
});

function channelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ch1',
    userId: 'u1',
    platform: 'YOUTUBE',
    externalId: 'ext1',
    title: 'Мой канал',
    avatarUrl: null,
    accessTokenEnc: '',
    refreshTokenEnc: null,
    expiresAt: null,
    scopes: ['youtube.upload'],
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function setup(opts: { channel?: unknown } = {}) {
  const prisma = {
    publishingChannel: {
      upsert: jest
        .fn()
        .mockImplementation(
          async ({ create }: { create: Record<string, unknown> }) => ({
            ...channelRow(),
            ...create,
          }),
        ),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest
        .fn()
        .mockResolvedValue('channel' in opts ? opts.channel : channelRow()),
      update: jest
        .fn()
        .mockImplementation(
          async ({ data }: { data: Record<string, unknown> }) => ({
            ...channelRow(),
            ...data,
          }),
        ),
      delete: jest.fn().mockResolvedValue(undefined),
    },
  };
  const plans = plansMock();
  const google = {
    configured: jest.fn().mockReturnValue(true),
    buildAuthUrl: jest
      .fn()
      .mockReturnValue('https://accounts.google.com/auth?state=x'),
    exchangeCode: jest.fn().mockResolvedValue({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ['youtube.upload'],
    }),
    fetchChannelInfo: jest.fn().mockResolvedValue({
      externalId: 'ext1',
      title: 'Мой канал',
      avatarUrl: null,
    }),
    refreshAccessToken: jest.fn().mockResolvedValue({
      accessToken: 'at-2',
      expiresAt: new Date(Date.now() + 3600_000),
    }),
    revoke: jest.fn().mockResolvedValue(undefined),
  };
  const tiktok = {
    configured: jest.fn().mockReturnValue(true),
    buildAuthUrl: jest
      .fn()
      .mockReturnValue('https://www.tiktok.com/auth?state=x'),
    exchangeCode: jest.fn(),
    fetchChannelInfo: jest.fn(),
    refreshAccessToken: jest.fn(),
    revoke: jest.fn().mockResolvedValue(undefined),
  };
  const service = new PublishingChannelService(
    prisma as never,
    plans as never,
    google as never,
    tiktok as never,
  );
  return { service, prisma, plans, google, tiktok };
}

describe('PublishingChannelService', () => {
  describe('buildAuthUrl', () => {
    it("гейтит тем же 'publication', что очередь публикации, и подписывает state", async () => {
      const { service, plans, google } = setup();
      const url = await service.buildAuthUrl('u1', 'YOUTUBE');
      expect(plans.assertUser).toHaveBeenCalledWith('u1', 'publication');
      expect(google.buildAuthUrl).toHaveBeenCalledWith(expect.any(String));
      expect(url).toContain('accounts.google.com');
    });

    it('404 на неизвестной платформе', async () => {
      const { service } = setup();
      await expect(service.buildAuthUrl('u1', 'FACEBOOK')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('403, если провайдер не настроен на сервере (нет ключей)', async () => {
      const { service, google } = setup();
      google.configured.mockReturnValue(false);
      await expect(service.buildAuthUrl('u1', 'YOUTUBE')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('handleCallback', () => {
    it('обменивает код, апсертит канал и не отдаёт токены наружу', async () => {
      const { service, prisma } = setup();
      const state = signOAuthState('u1', 'YOUTUBE', TOKEN_KEY);
      const view = await service.handleCallback('YOUTUBE', 'code-1', state);
      expect(view).toEqual({
        id: 'ch1',
        platform: 'YOUTUBE',
        externalId: 'ext1',
        title: 'Мой канал',
        avatarUrl: null,
        status: 'ACTIVE',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(view).not.toHaveProperty('accessTokenEnc');
      expect(prisma.publishingChannel.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            platform_externalId: { platform: 'YOUTUBE', externalId: 'ext1' },
          },
        }),
      );
    });

    it('отвергает просроченный/подделанный state', async () => {
      const { service } = setup();
      await expect(
        service.handleCallback('YOUTUBE', 'code-1', 'garbage'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('отвергает state с несовпадающей платформой', async () => {
      const { service } = setup();
      const state = signOAuthState('u1', 'TIKTOK', TOKEN_KEY);
      await expect(
        service.handleCallback('YOUTUBE', 'code-1', state),
      ).rejects.toThrow(ForbiddenException);
    });

    it('требует code от площадки', async () => {
      const { service } = setup();
      const state = signOAuthState('u1', 'YOUTUBE', TOKEN_KEY);
      await expect(
        service.handleCallback('YOUTUBE', undefined, state),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('disconnect', () => {
    it('404, если канал не найден или принадлежит другому пользователю', async () => {
      const { service } = setup({ channel: null });
      await expect(service.disconnect('u1', 'ch1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('удаляет строку даже если провайдер отказал в revoke (best-effort)', async () => {
      const { service, prisma, google } = setup();
      google.revoke.mockRejectedValueOnce(new Error('boom'));
      await service.disconnect('u1', 'ch1');
      expect(prisma.publishingChannel.delete).toHaveBeenCalledWith({
        where: { id: 'ch1' },
      });
    });

    it('чужой канал (userId не совпадает) — тоже 404, не 403 (не разглашаем существование)', async () => {
      const { service } = setup({ channel: channelRow({ userId: 'other' }) });
      await expect(service.disconnect('u1', 'ch1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('ensureFreshToken', () => {
    it('возвращает текущий токен без сети, если срок ещё не подошёл', async () => {
      const { service, google } = setup({
        channel: channelRow({
          accessTokenEnc: encryptToken('at-cached', TOKEN_KEY),
          expiresAt: new Date(Date.now() + 3600_000),
        }),
      });
      const result = await service.ensureFreshToken('ch1');
      expect(result.accessToken).toBe('at-cached');
      expect(google.refreshAccessToken).not.toHaveBeenCalled();
    });

    it('обновляет токен, когда до истечения меньше буфера в 60 секунд', async () => {
      const { service, prisma } = setup({
        channel: channelRow({
          accessTokenEnc: encryptToken('at-old', TOKEN_KEY),
          refreshTokenEnc: encryptToken('rt-1', TOKEN_KEY),
          expiresAt: new Date(Date.now() + 1000),
        }),
      });
      const result = await service.ensureFreshToken('ch1');
      expect(result.accessToken).toBe('at-2');
      expect(prisma.publishingChannel.update).toHaveBeenCalled();
    });

    it('переводит канал в REVOKED, когда refresh-токен отсутствует', async () => {
      const { service, prisma } = setup({
        channel: channelRow({
          accessTokenEnc: encryptToken('at-old', TOKEN_KEY),
          refreshTokenEnc: null,
          expiresAt: new Date(Date.now() - 1000),
        }),
      });
      await expect(service.ensureFreshToken('ch1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.publishingChannel.update).toHaveBeenCalledWith({
        where: { id: 'ch1' },
        data: { status: 'REVOKED' },
      });
    });

    it('переводит канал в REVOKED, когда провайдер отказал в обновлении токена', async () => {
      const { service, prisma, google } = setup({
        channel: channelRow({
          accessTokenEnc: encryptToken('at-old', TOKEN_KEY),
          refreshTokenEnc: encryptToken('rt-1', TOKEN_KEY),
          expiresAt: new Date(Date.now() - 1000),
        }),
      });
      google.refreshAccessToken.mockRejectedValueOnce(
        new Error('invalid_grant'),
      );
      await expect(service.ensureFreshToken('ch1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.publishingChannel.update).toHaveBeenCalledWith({
        where: { id: 'ch1' },
        data: { status: 'REVOKED' },
      });
    });

    it('отказывает использовать неактивный (REVOKED) канал без попытки обновить токен', async () => {
      const { service, google } = setup({
        channel: channelRow({ status: 'REVOKED' }),
      });
      await expect(service.ensureFreshToken('ch1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(google.refreshAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('listForUser', () => {
    it('фильтрует по userId и мапит в view без токенов', async () => {
      const { service, prisma } = setup();
      prisma.publishingChannel.findMany.mockResolvedValueOnce([channelRow()]);
      const list = await service.listForUser('u1');
      expect(prisma.publishingChannel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1' } }),
      );
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty('accessTokenEnc');
    });
  });
});
