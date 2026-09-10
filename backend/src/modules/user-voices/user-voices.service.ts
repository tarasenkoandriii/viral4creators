/**
 * UserVoicesService — клонирование голоса пользователем через Resemble AI
 * (этап 73, TODO п.32, doc/AI-ACTORS-NO-REFERENCE-SPEC.md §3,
 * doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.3).
 *
 * Поток — presigned-Blob (тот же приём, что фото персонажа бренда и
 * сцены-референсы): `createUploadUrl` минтит id и presigned PUT,
 * `confirmClone` подтверждает, что запись реально загружена, проверяет
 * согласие и лимит, и запускает асинхронное обучение у Resemble.
 * Готовность приходит вебхуком (`handleWebhook`) ИЛИ подтягивается
 * poll-фоллбеком при каждом `list()` (§5.4 TTS-спека — для стендов без
 * публичного HTTPS-эндпоинта под вебхук).
 */

import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { head } from '@vercel/blob';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { ResembleService } from '../tts/resemble.service';
import { resembleWebhookUrl } from './resemble-webhook-secret';
import {
  VoiceCloneRequestDto,
  VoiceSampleUploadUrlRequestDto,
  sampleExtFor,
} from './dto/user-voices.dto';
import {
  UserVoiceStatus,
  UserVoiceView,
} from '../../common/types/user-voice.types';
import { pathnameFromBlobUrl } from '../../common/blob-paths';

/**
 * TODO §3.6.2: лимит клонов на пользователя — Resemble тарифицирует
 * количеством голосов на АККАУНТ (общий, не per-user — у продукта один
 * `RESEMBLE_API_KEY` на всех), значит лимит обязан быть на нашей
 * стороне, не только через ai-usage. FAILED-попытки в счёт не идут —
 * неудача не должна сжигать квоту пользователя навсегда.
 */
const MAX_USER_VOICES = 3;

type UserVoiceRow = {
  id: string;
  userId: string;
  label: string;
  status: 'TRAINING' | 'READY' | 'FAILED';
  resembleVoiceId: string | null;
  sampleUrl: string;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toView(row: UserVoiceRow): UserVoiceView {
  const status: UserVoiceStatus =
    row.status === 'READY'
      ? 'ready'
      : row.status === 'FAILED'
        ? 'failed'
        : 'training';
  return {
    id: row.id,
    label: row.label,
    status,
    resembleVoiceId: row.resembleVoiceId,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class UserVoicesService {
  private readonly logger = new Logger(UserVoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly plans: PlanService,
    private readonly aiUsage: AiUsageService,
    private readonly resemble: ResembleService,
  ) {}

  async createUploadUrl(
    userId: string,
    dto: VoiceSampleUploadUrlRequestDto,
  ): Promise<{ uploadUrl: string; pathname: string; voiceId: string }> {
    await this.plans.assertUser(userId, 'voiceCloning');
    await this.assertUnderLimit(userId);
    const voiceId = randomUUID();
    const pathname = `users/${userId}/voices/${voiceId}/sample.${sampleExtFor(dto.mimeType)}`;
    const { uploadUrl } = await this.blob.createUploadUrl(
      pathname,
      dto.mimeType,
      15 * 1024 * 1024,
    );
    return { uploadUrl, pathname, voiceId };
  }

  async confirmClone(
    userId: string,
    dto: VoiceCloneRequestDto,
  ): Promise<UserVoiceView> {
    await this.plans.assertUser(userId, 'voiceCloning');
    await this.plans.assertCanSpendUser(userId);
    const expectedPrefix = `users/${userId}/voices/`;
    if (!dto.pathname.startsWith(expectedPrefix)) {
      throw new BadRequestException(
        `pathname must start with "${expectedPrefix}"`,
      );
    }
    if (!dto.consent) {
      throw new BadRequestException(
        'Нужно подтвердить согласие на использование записи для клонирования голоса',
      );
    }

    let sampleUrl: string;
    try {
      sampleUrl = (await head(dto.pathname)).url;
    } catch (e) {
      throw new BadRequestException(
        `Запись не найдена в хранилище по пути "${dto.pathname}" — сначала загрузите её через voices/upload-url (${e instanceof Error ? e.message : String(e)})`,
      );
    }

    // voiceId уже был определён в createUploadUrl и зашит в pathname —
    // тот же приём, что sceneId у reference-assets.
    const voiceId = dto.pathname.slice(expectedPrefix.length).split('/')[0];
    const label = dto.label.trim();

    // Е-4.2 шестого аудита: раньше count() (лимит) и create() (сама
    // строка) были разнесены платным вызовом Resemble между ними — два
    // параллельных запроса при count=2 оба проходили проверку лимита и
    // ОБА стартовали клон, 4 голоса вместо 3 (Resemble тарифицирует
    // количеством голосов на ОБЩИЙ аккаунт — см. доккомментарий
    // MAX_USER_VOICES выше). Проверка и резерв слота — теперь ОДНОЙ
    // транзакцией под advisory-lock по userId, тот же приём, что
    // `CreditLedgerService.reserveForGeneration()`. Строка создаётся
    // СРАЗУ (status TRAINING, resembleVoiceId ещё не известен) — именно
    // она и есть резерв: следующий параллельный запрос увидит её в
    // count() (WHERE status != FAILED) и получит отказ, даже пока
    // Resemble этого первого запроса ещё не ответил.
    await this.prisma.$transaction(async (tx: typeof this.prisma) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user-voices:${userId}`}))`;
      const count = await tx.userVoice.count({
        where: { userId, status: { not: 'FAILED' } },
      });
      if (count >= MAX_USER_VOICES) {
        throw new BadRequestException(
          `Достигнут лимит ${MAX_USER_VOICES} клонированных голосов — удалите один, чтобы создать новый`,
        );
      }
      await tx.userVoice.create({
        data: {
          id: voiceId,
          userId,
          label,
          status: 'TRAINING',
          sampleUrl,
          consentAt: new Date(),
        },
      });
    });

    const clone = await this.resemble.cloneVoice(
      label,
      sampleUrl,
      resembleWebhookUrl(),
    );

    if (!clone.ok) {
      // Явный отказ Resemble ДО старта обучения — денег с нас не взяли,
      // поэтому и ai-usage.record не пишем (тот же принцип «пишем в
      // момент реального старта платного вызова», что у avatar-generation,
      // только здесь «старт» — это именно успешный ответ Resemble).
      // Строка уже создана резервом выше — здесь её же обновляем, а не
      // заводим вторую.
      const row = await this.prisma.userVoice.update({
        where: { id: voiceId },
        data: { status: 'FAILED', error: clone.reason },
      });
      return toView(row as UserVoiceRow);
    }

    await this.aiUsage.record({
      operation: 'voice-clone',
      model: 'resemble-voice-clone',
      userId,
    });

    const row = await this.prisma.userVoice.update({
      where: { id: voiceId },
      data: { resembleVoiceId: clone.resembleVoiceId },
    });
    return toView(row as UserVoiceRow);
  }

  /**
   * Список голосов пользователя. Для ещё обучающихся строк —
   * best-effort poll-фоллбек готовности (§5.4 TTS-спека): дешёво, лимит
   * в 3 голоса на пользователя не даёт этому разрастись в шторм вызовов.
   */
  async list(userId: string): Promise<UserVoiceView[]> {
    const rows = (await this.prisma.userVoice.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })) as UserVoiceRow[];

    const refreshed = await Promise.all(
      rows.map(async (row) => {
        if (row.status !== 'TRAINING' || !row.resembleVoiceId) return row;
        return this.refreshStatus(row);
      }),
    );
    return refreshed.map(toView);
  }

  private async refreshStatus(row: UserVoiceRow): Promise<UserVoiceRow> {
    const polled = await this.resemble.getVoiceStatus(row.resembleVoiceId!);
    if (!polled) return row; // не удалось узнать — оставляем TRAINING, попробуем в следующий раз
    if (polled.status === 'finished') {
      return (await this.prisma.userVoice.update({
        where: { id: row.id },
        data: { status: 'READY' },
      })) as UserVoiceRow;
    }
    if (polled.status === 'failed' || polled.status === 'error') {
      return (await this.prisma.userVoice.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          error: `Resemble: статус "${polled.status}"`,
        },
      })) as UserVoiceRow;
    }
    // 'pending'/другой неизвестный статус — всё ещё обучается, ничего не меняем.
    return row;
  }

  async remove(userId: string, id: string): Promise<void> {
    const row = (await this.prisma.userVoice.findUnique({
      where: { id },
    })) as UserVoiceRow | null;
    if (!row || row.userId !== userId) {
      throw new NotFoundException('Голос не найден');
    }
    if (row.resembleVoiceId) {
      await this.resemble.deleteVoice(row.resembleVoiceId);
    }
    const pathname = pathnameFromBlobUrl(row.sampleUrl, 'users/');
    if (pathname) {
      await this.blob.deleteBlob(pathname);
    }
    await this.prisma.userVoice.delete({ where: { id } });
  }

  /**
   * Вебхук Resemble (`{"ok": true, "id": "voice-uuid", "status":
   * "finished"}`, §4.3 TTS-спека) — контроллер уже проверил секрет,
   * здесь только сопоставление и запись статуса. Неизвестный id —
   * тихий no-op (не 404 наружу вебхуку — Resemble не обязан понимать
   * наш ответ, а повторные попытки безобидны).
   */
  async handleWebhook(payload: {
    ok?: boolean;
    id?: string;
    status?: string;
  }): Promise<void> {
    const resembleVoiceId = payload.id;
    if (!resembleVoiceId) return;
    const row = (await this.prisma.userVoice.findFirst({
      where: { resembleVoiceId },
    })) as UserVoiceRow | null;
    if (!row) {
      this.logger.warn(
        `вебхук Resemble для неизвестного голоса ${resembleVoiceId} — пропущен`,
      );
      return;
    }
    if (row.status !== 'TRAINING') return; // уже разрешилось (READY/FAILED) — повторный вебхук не переигрываем
    if (payload.ok === true && payload.status === 'finished') {
      await this.prisma.userVoice.update({
        where: { id: row.id },
        data: { status: 'READY' },
      });
    } else {
      await this.prisma.userVoice.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          error: `Resemble сообщил об ошибке обучения (status: ${payload.status ?? 'unknown'})`,
        },
      });
    }
  }

  private async assertUnderLimit(userId: string): Promise<void> {
    const count = await this.prisma.userVoice.count({
      where: { userId, status: { not: 'FAILED' } },
    });
    if (count >= MAX_USER_VOICES) {
      throw new BadRequestException(
        `Достигнут лимит ${MAX_USER_VOICES} клонированных голосов — удалите один, чтобы создать новый`,
      );
    }
  }
}
