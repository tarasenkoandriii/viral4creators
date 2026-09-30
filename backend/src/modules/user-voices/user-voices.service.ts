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
  ConflictException,
  ForbiddenException,
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
import {
  personaModeEnabled,
  personaSelfLikenessEligible,
  PersonaEligibilityRow,
} from '../persona/persona-looks.rules';
import { PERSONA_VOICE_CONSENT_VERSION } from './persona-voice-consent';
import { isPersonaVoice, PersonaVoiceDb } from './persona-voice';

/**
 * TODO §3.6.2: лимит клонов на пользователя — Resemble тарифицирует
 * количеством голосов на АККАУНТ (общий, не per-user — у продукта один
 * `RESEMBLE_API_KEY` на всех), значит лимит обязан быть на нашей
 * стороне, не только через ai-usage. FAILED-попытки в счёт не идут —
 * неудача не должна сжигать квоту пользователя навсегда.
 *
 * Голос персоны «Я в кадре» (`personaId` не пусто) в этот лимит НЕ
 * входит (ТЗ TZ-Greeting-2.0 §4.2, §6): он один на персону, а персона
 * одна на аккаунт — потолок у него свой и равен единице.
 */
export const MAX_USER_VOICES = 3;

/** Голосов на персону — один, подходит ко всем образам (§4.1 п.6). */
export const MAX_PERSONA_VOICES = 1;

type UserVoiceRow = {
  id: string;
  userId: string;
  personaId?: string | null;
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
    personaId: row.personaId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Удалённый голос — прочь из бренд-буков пользователя (CONTRACT6 п.4).
 * Бренд-бук хранит `ttsVoiceId` строкой без связи с `UserVoice`, и после
 * удаления голоса новый ролик по нему озвучивался бы клоном, согласие на
 * который забрали (у Resemble удаление может и не пройти сразу — список
 * повтора). Только бренд-буки ЭТОГО пользователя: чужих его голос не
 * касается. Снимки уже созданных сессий не трогаем — их ловит проверка у
 * денег (`personaRenderProblem`, голос бренд-бука).
 */
export async function forgetVoiceInBrandManifests(
  prisma: {
    brandManifest: {
      updateMany(args: {
        where: { userId: string; ttsVoiceId: string };
        data: { ttsVoiceId: null; ttsProvider: null };
      }): Promise<unknown>;
    };
  },
  userId: string,
  resembleVoiceId: string,
): Promise<void> {
  await prisma.brandManifest.updateMany({
    where: { userId, ttsVoiceId: resembleVoiceId },
    // Провайдер без голоса ничего не значит — так же чистит правка
    // снимка (`applySnapshotEdit`: голос null → провайдер null).
    data: { ttsVoiceId: null, ttsProvider: null },
  });
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
    // В-1 (временно по рекомендации ТЗ): клон голоса персоны — Standard+,
    // тот же признак, что у обычного клона.
    await this.plans.assertUser(userId, 'voiceCloning');
    if (dto.forPersona) {
      const persona = await this.requireVoicePersona(userId);
      await this.assertPersonaHasNoVoice(this.prisma, persona.id);
    } else {
      await this.assertUnderLimit(userId);
    }
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
    // Голос персоны: запись начинается фразой согласия вслух (§4.6) —
    // клиент обязан показать ДЕЙСТВУЮЩУЮ редакцию фразы.
    if (
      dto.forPersona &&
      dto.consentPhraseVersion !== PERSONA_VOICE_CONSENT_VERSION
    ) {
      throw new BadRequestException(
        'Фраза согласия обновилась — перечитайте её и запишите голос заново',
      );
    }
    const persona = dto.forPersona
      ? await this.requireVoicePersona(userId)
      : null;

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
    //
    // Голос персоны — под тем же замком, но со своим счётом: один на
    // персону, обычные клоны его не видят и он не видит их (§4.2).
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user-voices:${userId}`}))`;
      if (persona) {
        await this.assertPersonaHasNoVoice(tx, persona.id);
      } else {
        const count = await tx.userVoice.count({
          where: { userId, personaId: null, status: { not: 'FAILED' } },
        });
        if (count >= MAX_USER_VOICES) {
          throw new BadRequestException(
            `Достигнут лимит ${MAX_USER_VOICES} клонированных голосов — удалите один, чтобы создать новый`,
          );
        }
      }
      await tx.userVoice.create({
        data: {
          id: voiceId,
          userId,
          label,
          status: 'TRAINING',
          sampleUrl,
          consentAt: new Date(),
          ...(persona ? { personaId: persona.id } : {}),
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
    if (row.resembleVoiceId) {
      await forgetVoiceInBrandManifests(
        this.prisma,
        userId,
        row.resembleVoiceId,
      );
    }
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

  /**
   * Это голос персоны этого пользователя? (см. `persona-voice.ts`) —
   * вызывают бренд-бук и поздравление: голос персоны назначается только
   * в PERSONAL бренд-буке и отправителем (CONTRACT5 п.5а).
   */
  isPersonaVoice(
    userId: string,
    voiceId: string | null | undefined,
  ): Promise<boolean> {
    return isPersonaVoice(
      this.prisma as unknown as PersonaVoiceDb,
      userId,
      voiceId,
    );
  }

  /**
   * Персона, которой можно записать голос: режим включён, согласие
   * действует, живость пройдена (те же условия, что у своего лица в
   * скетче, `personaSelfLikenessEligible`).
   */
  private async requireVoicePersona(userId: string): Promise<{ id: string }> {
    if (!personaModeEnabled()) {
      throw new NotFoundException({
        code: 'PERSONA_DISABLED',
        message: 'Режим «Я в кадре» недоступен',
      });
    }
    const persona = (await this.prisma.persona.findFirst({
      where: { userId, revokedAt: null },
    })) as (PersonaEligibilityRow & { id: string }) | null;
    if (!persona) {
      throw new NotFoundException(
        'Сначала создайте себя в разделе «Я в кадре»',
      );
    }
    if (!personaSelfLikenessEligible(persona)) {
      throw new ForbiddenException(
        'Голос для «Я в кадре» можно записать после согласия и проверки селфи',
      );
    }
    return { id: persona.id };
  }

  /** Один голос на персону; неудачные попытки не в счёт. */
  private async assertPersonaHasNoVoice(
    db: {
      userVoice: {
        count(args: { where: Record<string, unknown> }): Promise<number>;
      };
    },
    personaId: string,
  ): Promise<void> {
    const count = await db.userVoice.count({
      where: { personaId, status: { not: 'FAILED' } },
    });
    if (count >= MAX_PERSONA_VOICES) {
      throw new ConflictException(
        'Голос для «Я в кадре» уже записан — удалите его, чтобы записать заново',
      );
    }
  }

  private async assertUnderLimit(userId: string): Promise<void> {
    // Голос персоны в лимит не входит (§4.2) — `personaId: null`.
    const count = await this.prisma.userVoice.count({
      where: { userId, personaId: null, status: { not: 'FAILED' } },
    });
    if (count >= MAX_USER_VOICES) {
      throw new BadRequestException(
        `Достигнут лимит ${MAX_USER_VOICES} клонированных голосов — удалите один, чтобы создать новый`,
      );
    }
  }
}
