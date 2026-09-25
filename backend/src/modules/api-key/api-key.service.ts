/**
 * ApiKeyService — выдача, список и отзыв ключей внешнего API
 * (этап 144, docs-tz/TZ-Vneshnee-API.md).
 *
 * Секрет существует ровно один раз — в ответе на выдачу. Дальше в базе
 * только его хеш и открытый префикс, и вернуть потерянный ключ нельзя
 * НИЧЕМ. Это не ограничение реализации, а её смысл: ключ, который мы
 * умеем показать второй раз, мы умеем показать и тому, кто добрался до
 * базы.
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { issueApiKey } from '../../common/api-key';
import { PlanService } from '../plan/plan.service';
import { isDeliverableUrl } from '../../common/api-webhook';

/** Сколько живых ключей держим на одного человека. */
export const MAX_ACTIVE_KEYS = 5;

export interface ApiKeyView {
  id: string;
  name: string;
  /** Куда сообщать об исходе заявки (этап 146). Пусто — не сообщать. */
  webhookUrl: string | null;
  /** Открытое начало ключа — по нему человек узнаёт свой в списке. */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface ApiKeyRow {
  id: string;
  name: string;
  webhookUrl?: string | null;
  hint: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export function toView(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    webhookUrl: row.webhookUrl ?? null,
    hint: row.hint,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

/** Имя ключа: у человека их несколько, и «ключ от 12 марта» не имя. */
export function normalizeKeyName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  return (name || 'Без названия').slice(0, 60);
}

@Injectable()
export class ApiKeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  /**
   * Ключи человека, новые сверху. Отозванные остаются в списке.
   *
   * Потолок отдаётся ВМЕСТЕ со списком (аудит этапа 145). Экран без
   * него знал бы число только копией у себя, а копии таких чисел
   * расходятся с оригиналом всегда в худшую сторону: человеку
   * показывают кнопку, которую сервер потом запрещает. Ровно это
   * правило записано в `frontend/src/lib/plan.ts` про матрицу
   * возможностей — здесь оно про то же самое.
   */
  async list(
    userId: string,
  ): Promise<{ keys: ApiKeyView[]; maxActive: number }> {
    const rows = (await this.prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })) as ApiKeyRow[];
    return { keys: rows.map(toView), maxActive: MAX_ACTIVE_KEYS };
  }

  /**
   * Выдать ключ. Секрет возвращается ЗДЕСЬ и больше нигде.
   *
   * Право проверяется на выдаче, а не только на входе: ключ, выданный
   * тому, кто им не воспользуется, — это лишний живой секрет, и
   * кончится он тем, что о нём забудут.
   */
  async issue(
    userId: string,
    nameRaw: unknown,
  ): Promise<{ key: ApiKeyView; secret: string }> {
    await this.plans.assertUser(userId, 'externalApi');

    // Потолок считается по ЖИВЫМ: отозванные остаются в истории, и
    // упереться в потолок из-за прошлогодних отзывов было бы странно.
    const active = await this.prisma.apiKey.count({
      where: { userId, revokedAt: null },
    });
    if (active >= MAX_ACTIVE_KEYS) {
      throw new ForbiddenException(
        `Больше ${MAX_ACTIVE_KEYS} живых ключей не бывает — отзовите ненужный`,
      );
    }

    const issued = issueApiKey();
    const row = (await this.prisma.apiKey.create({
      data: {
        userId,
        name: normalizeKeyName(nameRaw),
        hint: issued.hint,
        keyHash: issued.keyHash,
      },
    })) as ApiKeyRow;
    return { key: toView(row), secret: issued.secret };
  }

  /**
   * Куда слать исход заявки (этап 146). Пустая строка — не слать.
   *
   * Адрес проверяется ЗДЕСЬ, а не при доставке: по нему пойдёт наш
   * сервер изнутри нашей же сети, и «проверим, когда будем стучаться»
   * означало бы, что негодный адрес живёт в базе до первого исхода — и
   * ошибку человек увидит не там, где её сделал.
   */
  async setWebhook(
    userId: string,
    id: string,
    urlRaw: unknown,
  ): Promise<ApiKeyView> {
    const url = typeof urlRaw === 'string' ? urlRaw.trim() : '';
    if (url && !isDeliverableUrl(url)) {
      throw new BadRequestException(
        'Адрес вебхука: только https и только публичный хост',
      );
    }
    const row = (await this.prisma.apiKey.findFirst({
      where: { id, userId },
    })) as ApiKeyRow | null;
    if (!row) throw new NotFoundException('Ключ не найден');

    const updated = (await this.prisma.apiKey.update({
      where: { id },
      data: { webhookUrl: url || null },
    })) as ApiKeyRow;
    return toView(updated);
  }

  /**
   * Отозвать. Строка остаётся: отозванный ключ — часть истории
   * доступа, и «этого ключа никогда не было» здесь ответ хуже, чем
   * «отозван тогда-то».
   */
  async revoke(userId: string, id: string): Promise<ApiKeyView> {
    // Отзыв ищется ПО ПАРЕ владелец+ключ: иначе чужой id в адресе
    // отзывал бы чужой ключ, и владелец узнал бы об этом по молчанию
    // своей интеграции.
    const row = (await this.prisma.apiKey.findFirst({
      where: { id, userId },
    })) as ApiKeyRow | null;
    if (!row) throw new NotFoundException('Ключ не найден');
    if (row.revokedAt) return toView(row);

    const updated = (await this.prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    })) as ApiKeyRow;
    return toView(updated);
  }
}
