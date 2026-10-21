/**
 * Права вкладки «FFmpeg» (ТЗ FFmpeg-server v1.1 §13.1).
 *
 * Гранулярного RBAC в admin-auth нет: единственный флаг — `isOperator`
 * (`User.isOperator`), понятия владельца/superadmin тоже нет. Поэтому
 * четыре серверных права `ffmpeg.read|operate|configure|media.read`
 * объявлены явно, но до появления RBAC выдаются ТОЛЬКО владельцу:
 * оператору (`isOperator`), чей Telegram id перечислен в env
 * `ADMIN_OWNER_TELEGRAM_IDS` (через запятую). Пустой список — запрет для
 * всех. Обычный оператор/QA viewer доступа не получает автоматически.
 * Скрытая кнопка в UI проверкой прав не считается — проверка здесь.
 */

import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export const FFMPEG_PERMISSIONS = [
  'ffmpeg.read',
  'ffmpeg.operate',
  'ffmpeg.configure',
  'ffmpeg.media.read',
] as const;
export type FfmpegPermission = (typeof FFMPEG_PERMISSIONS)[number];

export const FFMPEG_ACCESS_DENIED =
  'Нет права на вкладку FFmpeg: до RBAC доступ только у владельца (ADMIN_OWNER_TELEGRAM_IDS)';

/** Telegram id владельцев из env; пробелы и пустые элементы отброшены. */
export function adminOwnerTelegramIds(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  return new Set(
    (env.ADMIN_OWNER_TELEGRAM_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export interface FfmpegActor {
  userId: string;
  permissions: FfmpegPermission[];
}

@Injectable()
export class FfmpegAdminAccess {
  constructor(private readonly prisma: PrismaService) {}

  /** Права пользователя; пустой массив — нет доступа. */
  async permissionsOf(userId: string): Promise<FfmpegPermission[]> {
    const owners = adminOwnerTelegramIds();
    if (owners.size === 0) return [];
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isOperator: true, telegramId: true },
    });
    if (!user?.isOperator || !user.telegramId) return [];
    return owners.has(String(user.telegramId)) ? [...FFMPEG_PERMISSIONS] : [];
  }

  async assert(
    userId: string,
    permission: FfmpegPermission,
  ): Promise<FfmpegActor> {
    const permissions = await this.permissionsOf(userId);
    if (!permissions.includes(permission))
      throw new ForbiddenException({
        message: FFMPEG_ACCESS_DENIED,
        code: 'FFMPEG_FORBIDDEN',
      });
    return { userId, permissions };
  }
}
