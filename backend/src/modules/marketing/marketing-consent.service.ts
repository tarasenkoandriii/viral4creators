/**
 * MarketingConsentService — согласие на рассылку подборки удачных роликов
 * через Telegram-бота (ТЗ §42, этап 63, doc/TODO.md §III.4).
 *
 * Отдельное согласие от оферты/условий использования (`legal/`,
 * `TERMS_VERSION`) — рассылка не блокирует ни один сценарий сервиса,
 * значит и re-ask при правке текста не нужен: здесь просто "сейчас
 * подписан или нет", по образцу LegalService, но без версии документа.
 *
 * Две даты, а не один булев флаг (см. комментарий на User в
 * schema.prisma): нужна и дата согласия (для аудита), и дата отписки —
 * иначе история "когда именно отписался" терялась бы при повторном
 * accept().
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface MarketingConsentStatus {
  consented: boolean;
  consentedAt: string | null;
  revokedAt: string | null;
}

interface ConsentRow {
  marketingConsentAt: Date | null;
  marketingConsentRevokedAt: Date | null;
}

@Injectable()
export class MarketingConsentService {
  constructor(private readonly prisma: PrismaService) {}

  async status(userId: string): Promise<MarketingConsentStatus> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { marketingConsentAt: true, marketingConsentRevokedAt: true },
    });
    return toStatus(row);
  }

  /** Согласиться — в том числе повторно, поверх уже отозванного согласия
   * (новый accept() просто выставляет свежую дату и снимает revokedAt). */
  async accept(userId: string): Promise<MarketingConsentStatus> {
    const row = await this.prisma.user.update({
      where: { id: userId },
      data: { marketingConsentAt: new Date(), marketingConsentRevokedAt: null },
      select: { marketingConsentAt: true, marketingConsentRevokedAt: true },
    });
    return toStatus(row);
  }

  /** Явная отписка в один клик — второй (после автоматической при отказе
   * Telegram доставить сообщение, см. MarketingBroadcastService) путь к
   * тому же результату. Идемпотентна: повторный вызов не портит уже
   * записанную дату отписки. */
  async revoke(userId: string): Promise<MarketingConsentStatus> {
    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { marketingConsentAt: true, marketingConsentRevokedAt: true },
    });
    if (!current?.marketingConsentAt || current.marketingConsentRevokedAt) {
      return toStatus(current);
    }
    const row = await this.prisma.user.update({
      where: { id: userId },
      data: { marketingConsentRevokedAt: new Date() },
      select: { marketingConsentAt: true, marketingConsentRevokedAt: true },
    });
    return toStatus(row);
  }
}

/** Pure — exported for the test. */
export function toStatus(row: ConsentRow | null): MarketingConsentStatus {
  return {
    consented: !!row?.marketingConsentAt && !row.marketingConsentRevokedAt,
    consentedAt: row?.marketingConsentAt?.toISOString() ?? null,
    revokedAt: row?.marketingConsentRevokedAt?.toISOString() ?? null,
  };
}
