/**
 * ApiWebhookService — доставка исхода заявки на адрес интегратора
 * (этап 146, docs-tz/TZ-Vneshnee-API.md).
 *
 * ## Вебхук не отменяет опрос
 *
 * `GET /v1/videos/:jobId` остаётся и после этого этапа. Вебхук без
 * опроса — обещание, которое некому проверить: если доставка не дошла
 * (упал их приёмник, сменился адрес, кончились попытки), у чужой
 * стороны не остаётся способа узнать исход вообще. Опрос — то, чем
 * вебхук проверяют.
 *
 * ## Одна доставка на заявку
 *
 * Исход у заявки один, поэтому и строка одна (`jobId` уникален).
 * Повторная попытка правит ту же строку: журнал доставок должен
 * отвечать на вопрос «дошло ли», а не быть лентой попыток, в которой
 * этот ответ надо собирать глазами.
 *
 * ## Отзыв ключа останавливает доставки (аудит этапа 146)
 *
 * Ключ отзывают, когда он утёк. Адрес вебхука стоит НА КЛЮЧЕ — то есть
 * поставить его мог тот же, кто ключом завладел, а подпись он проверит
 * хешем ключа, который у него есть. Первая редакция продолжала слать
 * исходы уже поданных заявок и после отзыва: «отозвать» означало
 * «нельзя подать новую», но не «прекратится то, что ключ привёл в
 * движение». Теперь перед каждой доставкой проверяется, жив ли ключ.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  isDelivered,
  isRetryable,
  signWebhook,
} from '../../common/api-webhook';
import {
  ApiVideoJobView,
  MAX_ATTEMPTS,
  nextAttemptAt,
  toJobView,
} from '../../common/api-video-job';

/** Дольше держать чужой приёмник нельзя: тик не резиновый. */
const TIMEOUT_MS = 10_000;
const LOCK_MS = 5 * 60 * 1000;
/** Столько доставок за тик. */
const BATCH = 5;

interface DeliveryRow {
  id: string;
  jobId: string;
  url: string;
  attempts: number;
}

@Injectable()
export class ApiWebhookService {
  private readonly logger = new Logger(ApiWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Поставить доставку в очередь. Зовётся, когда заявка кончилась —
   * неважно, удачей или отказом: «не получилось» это тоже исход, и
   * молчать о нём значит оставить чужой скрипт ждать вечно.
   *
   * Лучшая попытка: заявка уже закрыта, и подвести её из-за вебхука
   * было бы обменом плохого на худшее.
   */
  async enqueue(
    userId: string,
    jobId: string,
    apiKeyId: string,
  ): Promise<boolean> {
    try {
      const key = (await this.prisma.apiKey.findUnique({
        where: { id: apiKeyId },
        select: { webhookUrl: true },
      })) as { webhookUrl: string | null } | null;
      if (!key?.webhookUrl) return false;

      // `upsert`, а не `create`: у заявки одна доставка, и повторный
      // заход после оборванного тика не должен падать на уникальности.
      await this.prisma.apiWebhookDelivery.upsert({
        where: { jobId },
        create: { jobId, userId, url: key.webhookUrl },
        update: {},
      });
      return true;
    } catch (e) {
      this.logger.warn(
        `доставка заявки ${jobId} не поставлена: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  /** Один заход по очереди доставок. Возвращает счётчики для истории крона. */
  async deliverDue(): Promise<{
    delivered: number;
    retried: number;
    gaveUp: number;
  }> {
    const rows = (await this.prisma.apiWebhookDelivery.findMany({
      where: {
        status: 'PENDING',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    })) as DeliveryRow[];

    // ПАРАЛЛЕЛЬНО (аудит этапа 146). У каждой доставки свой таймаут в
    // десять секунд, и пять подряд — это пятьдесят секунд поверх фаз
    // заявок, в том же тике: мимо таймаута функции. Приёмники у них
    // разные, друг друга они не ждут, и ни одна наружу не бросает.
    const outcomes = await Promise.all(rows.map((row) => this.deliverOne(row)));
    return {
      delivered: outcomes.filter((o) => o === 'delivered').length,
      retried: outcomes.filter((o) => o === 'retried').length,
      gaveUp: outcomes.filter((o) => o === 'gaveUp').length,
    };
  }

  private async deliverOne(
    row: DeliveryRow,
  ): Promise<'delivered' | 'retried' | 'gaveUp' | 'skipped'> {
    // Захват до сетевого вызова — тот же приём, что у заявок: иначе
    // параллельный тик отправит второй раз, и чужая сторона получит
    // дубль без всякой возможности их различить.
    const claim = await this.prisma.apiWebhookDelivery.updateMany({
      where: {
        id: row.id,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
      },
      data: { lockedUntil: new Date(Date.now() + LOCK_MS) },
    });
    if (claim.count === 0) return 'skipped';

    const target = await this.targetOf(row.jobId);
    if (!target) {
      await this.giveUp(row, 'заявки нет, или ключ отозван');
      return 'gaveUp';
    }

    const outcome = await this.post(row.url, target.view, target.secret);
    if (outcome.statusCode !== null && isDelivered(outcome.statusCode)) {
      await this.prisma.apiWebhookDelivery.update({
        where: { id: row.id },
        data: {
          status: 'DELIVERED',
          attempts: row.attempts + 1,
          lastStatusCode: outcome.statusCode,
          lastError: null,
          deliveredAt: new Date(),
          lockedUntil: null,
          nextAttemptAt: null,
        },
      });
      return 'delivered';
    }

    const attempts = row.attempts + 1;
    const exhausted =
      attempts >= MAX_ATTEMPTS || !isRetryable(outcome.statusCode);
    if (exhausted) {
      await this.giveUp(row, outcome.error, outcome.statusCode, attempts);
      return 'gaveUp';
    }
    await this.prisma.apiWebhookDelivery.update({
      where: { id: row.id },
      data: {
        attempts,
        lastStatusCode: outcome.statusCode,
        lastError: outcome.error,
        nextAttemptAt: nextAttemptAt(attempts, new Date()),
        lockedUntil: null,
      },
    });
    return 'retried';
  }

  /**
   * Что и чем подписывать. `null` — доставлять нечего или некому.
   *
   * Живёт ЗДЕСЬ, а не в вызывающем (аудит этапа 146). Первая редакция
   * принимала два замыкания от воркера — инверсия без причины: у
   * сервиса есть та же база. Она же и виновата в пропущенной проверке
   * отзыва: у правила «ключ должен быть жив» не было естественного
   * места.
   */
  private async targetOf(
    jobId: string,
  ): Promise<{ view: ApiVideoJobView; secret: string } | null> {
    const job = (await this.prisma.apiVideoJob.findUnique({
      where: { id: jobId },
    })) as (Parameters<typeof toJobView>[0] & { apiKeyId: string }) | null;
    if (!job) return null;

    const key = (await this.prisma.apiKey.findUnique({
      where: { id: job.apiKeyId },
      select: { keyHash: true, revokedAt: true },
    })) as { keyHash: string; revokedAt: Date | null } | null;
    // Отозванный ключ — не «просто старый»: его отзывают, когда он
    // утёк, а адрес доставки мог поставить тот, кто им завладел.
    if (!key || key.revokedAt) return null;

    return { view: toJobView(job), secret: key.keyHash };
  }

  private async giveUp(
    row: DeliveryRow,
    error: string | null,
    statusCode: number | null = null,
    attempts = row.attempts + 1,
  ): Promise<void> {
    await this.prisma.apiWebhookDelivery.update({
      where: { id: row.id },
      data: {
        status: 'FAILED',
        attempts,
        lastStatusCode: statusCode,
        lastError: error,
        nextAttemptAt: null,
        lockedUntil: null,
      },
    });
  }

  private async post(
    url: string,
    view: ApiVideoJobView,
    secret: string,
  ): Promise<{ statusCode: number | null; error: string | null }> {
    const timestamp = String(Date.now());
    const body = JSON.stringify(view);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signWebhook(secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return {
        statusCode: res.status,
        error: isDelivered(res.status) ? null : `ответ ${res.status}`,
      };
    } catch (e) {
      // Адрес в сообщение не кладём: он чужой и уже есть в строке.
      return {
        statusCode: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
