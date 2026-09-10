/**
 * LegalService — acceptance of the offer and the terms of use (spec §20,
 * Stage 24).
 *
 * What acceptance is FOR here: the terms are what make the library legal —
 * §4 of the terms assigns the analyses (the Gemini breakdowns) to the
 * service, which is why one shared library may serve every user (§21). So
 * the first analysis in a session is gated on acceptance in the UI, and
 * an identified user's acceptance is recorded here with the version they
 * saw, so a later revision can be re-asked.
 *
 * The anonymous browser path keeps its acceptance in localStorage: there
 * is no user row to write to, and creating one just to store a checkbox
 * would be worse for the person than the checkbox itself.
 */

import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Bumped when the documents change materially — then everyone re-accepts. */
export const TERMS_VERSION = '2026-09-08';

export interface TermsStatus {
  version: string;
  acceptedAt: string | null;
  /** False when never accepted, or accepted an older version. */
  accepted: boolean;
}

interface UserTermsRow {
  termsAcceptedAt: Date | null;
  termsVersion: string | null;
}

@Injectable()
export class LegalService {
  constructor(private readonly prisma: PrismaService) {}

  async status(userId: string): Promise<TermsStatus> {
    const row: UserTermsRow | null = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { termsAcceptedAt: true, termsVersion: true },
    });
    return toStatus(row);
  }

  /**
   * Согласие обязательно перед разбором (§20, этап 38, А-2.16).
   *
   * До этого этапа проверка жила только в интерфейсе, а на согласии стоят
   * права сервиса на Разборы (§4 условий) и вместе с ними легитимность
   * общей Библиотеки: разбор, сделанный без согласия, попадал в неё и
   * предлагался другим пользователям.
   *
   * Анонимный (`userId === null`) проходит: строки пользователя у него
   * нет, писать согласие некуда, и заводить её ради галочки хуже для
   * человека, чем сама галочка (см. шапку файла). Его согласие живёт в
   * localStorage — слабее, и это осознанная цена анонимного сценария.
   */
  async assertAccepted(userId: string | null | undefined): Promise<void> {
    if (!userId) return;
    const { accepted } = await this.status(userId);
    if (accepted) return;
    throw new ForbiddenException(
      'Чтобы разобрать ролик, примите оферту и условия использования — они определяют права на разбор.',
    );
  }

  async accept(userId: string, version: string): Promise<TermsStatus> {
    const row: UserTermsRow = await this.prisma.user.update({
      where: { id: userId },
      data: { termsAcceptedAt: new Date(), termsVersion: version },
      select: { termsAcceptedAt: true, termsVersion: true },
    });
    return toStatus(row);
  }
}

/** Pure — exported for the test. */
export function toStatus(row: UserTermsRow | null): TermsStatus {
  return {
    version: TERMS_VERSION,
    acceptedAt: row?.termsAcceptedAt?.toISOString() ?? null,
    accepted: !!row?.termsAcceptedAt && row.termsVersion === TERMS_VERSION,
  };
}
