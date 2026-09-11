/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { MarketingConsentService, toStatus } from './marketing-consent.service';

function build(row: Record<string, unknown> | null) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(row),
      // Реальный `prisma.user.update()` возвращает строку ПОСЛЕ записи —
      // мок должен слить `data` из вызова поверх исходной строки, а не
      // молча отдавать её как была: иначе `revoke()`/`accept()` в тесте
      // видят несуществующий "предыдущий" `marketingConsentRevokedAt` и
      // `toStatus()` считает подписку активной уже после отписки.
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...row, ...data }),
        ),
    },
  };
  return { svc: new MarketingConsentService(prisma as any), prisma };
}

describe('MarketingConsentService (ТЗ §42, этап 63)', () => {
  describe('status', () => {
    it('никогда не соглашался — consented: false, обе даты null', async () => {
      const { svc } = build({
        marketingConsentAt: null,
        marketingConsentRevokedAt: null,
      });
      await expect(svc.status('u1')).resolves.toEqual({
        consented: false,
        consentedAt: null,
        revokedAt: null,
      });
    });

    it('согласился и не отзывал — consented: true', async () => {
      const at = new Date('2026-01-01T00:00:00Z');
      const { svc } = build({
        marketingConsentAt: at,
        marketingConsentRevokedAt: null,
      });
      await expect(svc.status('u1')).resolves.toEqual({
        consented: true,
        consentedAt: at.toISOString(),
        revokedAt: null,
      });
    });

    it('согласился и отозвал — consented: false, но дата согласия сохранена (история)', async () => {
      const at = new Date('2026-01-01T00:00:00Z');
      const revokedAt = new Date('2026-01-05T00:00:00Z');
      const { svc } = build({
        marketingConsentAt: at,
        marketingConsentRevokedAt: revokedAt,
      });
      await expect(svc.status('u1')).resolves.toEqual({
        consented: false,
        consentedAt: at.toISOString(),
        revokedAt: revokedAt.toISOString(),
      });
    });
  });

  describe('accept', () => {
    it('ставит свежую дату согласия и снимает revokedAt', async () => {
      const { svc, prisma } = build({
        marketingConsentAt: new Date(),
        marketingConsentRevokedAt: null,
      });
      await svc.accept('u1');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: {
          marketingConsentAt: expect.any(Date),
          marketingConsentRevokedAt: null,
        },
        select: {
          marketingConsentAt: true,
          marketingConsentRevokedAt: true,
        },
      });
    });

    it('переподписка поверх уже отозванного согласия работает так же', async () => {
      const { svc, prisma } = build({
        marketingConsentAt: new Date(),
        marketingConsentRevokedAt: null,
      });
      await svc.accept('u1');
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('revoke — отписка в один клик', () => {
    it('активная подписка → ставит revokedAt', async () => {
      const { svc, prisma } = build({
        marketingConsentAt: new Date('2026-01-01T00:00:00Z'),
        marketingConsentRevokedAt: null,
      });
      const result = await svc.revoke('u1');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { marketingConsentRevokedAt: expect.any(Date) },
        select: {
          marketingConsentAt: true,
          marketingConsentRevokedAt: true,
        },
      });
      expect(result.consented).toBe(false);
    });

    it('идемпотентна: уже отозвано — не трогает базу повторно', async () => {
      const { svc, prisma } = build({
        marketingConsentAt: new Date('2026-01-01T00:00:00Z'),
        marketingConsentRevokedAt: new Date('2026-01-02T00:00:00Z'),
      });
      await svc.revoke('u1');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('никогда не соглашался — тоже без обращения к update', async () => {
      const { svc, prisma } = build({
        marketingConsentAt: null,
        marketingConsentRevokedAt: null,
      });
      await svc.revoke('u1');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('неизвестный пользователь — не падает', async () => {
      const { svc, prisma } = build(null);
      const result = await svc.revoke('u-unknown');
      expect(result.consented).toBe(false);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});

describe('toStatus', () => {
  it('null-строка — не подписан', () => {
    expect(toStatus(null)).toEqual({
      consented: false,
      consentedAt: null,
      revokedAt: null,
    });
  });
});
