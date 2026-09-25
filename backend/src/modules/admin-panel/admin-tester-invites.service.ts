/**
 * Приглашения тестировщиков для оператора (этап 155).
 *
 * Вкладка админки появится этапом 4 ТЗ; пока это два маршрута, без
 * которых этап нечем пользоваться: приглашение надо чем-то завести и
 * где-то взять готовую ссылку.
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { inviteLink, inviteToken } from '../../common/tester-invite';
import {
  normalizeFreeScenarios,
  unknownScenarios,
} from '../../common/test-user-scenarios';

export interface TesterInviteView {
  id: string;
  label: string;
  freeScenarios: string[];
  expiresAt: string | null;
  /** Готовая ссылка — оператору её остаётся только скопировать. */
  link: string;
  activated: boolean;
  activatedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

@Injectable()
export class AdminTesterInvitesService {
  private readonly logger = new Logger(AdminTesterInvitesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<TesterInviteView[]> {
    const rows = await this.prisma.testerInvite.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => this.view(row));
  }

  async create(
    actorId: string,
    input: {
      label: string;
      freeScenarios: string[];
      expiresAt?: string | null;
    },
  ): Promise<TesterInviteView> {
    const label = input.label?.trim();
    if (!label) {
      throw new BadRequestException(
        'Подпись обязательна — иначе в списке не отличить одно приглашение от другого.',
      );
    }
    // Незнакомый сценарий — отказ, а не молчаливый пропуск: тот же
    // приём, что у `AdminUsersService.patch`. Иначе оператор считает,
    // что открыл доступ, а он не открыт.
    const unknown = unknownScenarios(input.freeScenarios);
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Неизвестные сценарии: ${unknown.join(', ')}`,
      );
    }
    const expiresAt = parseExpiry(input.expiresAt);

    const row = await this.prisma.testerInvite.create({
      data: {
        token: inviteToken(),
        label,
        freeScenarios: normalizeFreeScenarios(input.freeScenarios),
        expiresAt,
        createdBy: actorId,
      },
    });
    this.logger.warn(
      `operator ${actorId} created tester invite ${row.id} (${label})`,
    );
    return this.view(row);
  }

  async revoke(
    actorId: string,
    id: string,
    reason: string,
  ): Promise<TesterInviteView> {
    const row = await this.prisma.testerInvite.update({
      where: { id },
      data: { revokedAt: new Date(), revokedReason: reason?.trim() || null },
    });
    // Отзыв гасит и уже выданный доступ: иначе «отозвал» означало бы
    // только «ссылка больше не работает», а человек продолжал бы
    // тратить.
    if (row.userId) {
      await this.prisma.user.update({
        where: { id: row.userId },
        data: { isTestUser: false, freeScenarios: [], testAccessUntil: null },
      });
    }
    this.logger.warn(
      `operator ${actorId} revoked tester invite ${id}: ${reason ?? '—'}`,
    );
    return this.view(row);
  }

  private view(row: {
    id: string;
    token: string;
    label: string;
    freeScenarios: string[];
    expiresAt: Date | null;
    activatedAt: Date | null;
    revokedAt: Date | null;
    userId: string | null;
    createdAt: Date;
  }): TesterInviteView {
    return {
      id: row.id,
      label: row.label,
      freeScenarios: row.freeScenarios,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      link: inviteLink(botUsername(), row.token),
      activated: !!row.userId,
      activatedAt: row.activatedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/**
 * Имя бота. Не задано — ссылку всё равно показываем, но с заметной
 * заглушкой: молчаливо собранный `https://t.me/undefined?start=…`
 * выглядел бы рабочим и не работал.
 */
function botUsername(): string {
  return (
    process.env.TELEGRAM_BOT_USERNAME?.trim() || 'ЗАДАЙТЕ_TELEGRAM_BOT_USERNAME'
  );
}

/**
 * Срок: конец указанного дня, а не его начало. «До 25-го» человек
 * читает как «25-е ещё моё», и полночь отобрала бы у него сутки.
 */
function parseExpiry(raw: string | null | undefined): Date | null {
  if (!raw?.trim()) return null;
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException('Срок не разобран — ожидается дата.');
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    parsed.setUTCHours(23, 59, 59, 999);
  }
  return parsed;
}
