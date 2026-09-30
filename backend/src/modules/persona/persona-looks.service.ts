/**
 * Образы персоны «Я в кадре» (ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §4.4, §4.5, §6):
 * создание по пресету, описанию и возрасту, переименование, мягкое
 * удаление, квота `persona-look` и сама генерация картинки — она же
 * базовый образ проверки селфи (`PersonaLookGenerator`, шов с модулем
 * персоны, `persona-look-generator.ts`).
 *
 * ## Откуда берётся картинка (Т-5)
 *
 * Только image-to-image из селфи персоны или другого её образа. В DTO
 * нет поля с путём или URL, источник выбирает `resolveLookSource` по
 * строкам базы, а путь сверяется с префиксом персоны. Чужая фотография
 * не проходит мимо селфи и согласия ни одним маршрутом.
 *
 * ## Квота (В-7)
 *
 * Тот же приём, что у ИИ-скетча (`image-sketch.service.ts`): считаем
 * оплаченные вызовы `persona-look` в `ai_usage` плюс живые брони —
 * строки образа `pending` младше пяти минут, иначе параллельные запросы
 * проходили бы скопом в окно между проверкой и записью расхода (A-10).
 * Базовый образ пишется операцией `persona-look-base` и квоту не тратит.
 */

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { BlobService } from '../storage/blob.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { SketchGeneratorService } from '../image-sketch/sketch-generator.service';
import { GEMINI_IMAGE_MODEL } from '../../common/gemini-image-model';
import {
  exhaustedQuota,
  startOfMonthUtc,
} from '../../common/image-generation-quota';
import {
  PERSONA_LOOK_QUOTA_SETTING_KEYS,
  PersonaLookQuota,
  PlanId,
  personaLookQuotaFor,
} from '../../common/plans';
import {
  celebrityLikenessMessage,
  findCelebrityLikeness,
} from '../../common/celebrity-likeness';
import { sanitizeSketchDescription } from '../../common/sketch-prompts';
import { PersonaLookGenerator } from './persona-look-generator';
import { personaLookToDto, PersonaLookView } from './persona-view';
import { mimeOfPathname } from './persona-rules';
import {
  buildPersonaLookPrompt,
  defaultLookLabel,
  isLookAge,
  LOOK_SOURCE_REFUSAL_MESSAGE,
  lookAgeWarning,
  lookPhotoPathname,
  LookSourceRow,
  PersonaEligibilityRow,
  PersonaLookWarning,
  personaModeEnabled,
  personaSelfLikenessEligible,
  referenceLookAge,
  resolveLookAge,
  resolveLookSource,
} from './persona-looks.rules';
import { CreatePersonaLookDto } from './persona-looks.dto';
import {
  personaVoiceConsentPhrase,
  PersonaVoiceConsentPhrase,
} from '../user-voices/persona-voice-consent';

/** Сколько живёт бронь квоты — как у скетча (`SKETCH_RESERVATION_TTL_MS`). */
export const PERSONA_LOOK_RESERVATION_TTL_MS = 5 * 60 * 1000;

/** Операция, по которой считается квота образов. */
export const PERSONA_LOOK_OPERATION = 'persona-look' as const;

interface PersonaRow extends PersonaEligibilityRow {
  id: string;
  userId: string;
  selfiePathname: string | null;
  sourcesPurgedAt: Date | null;
  ageMax: number | null;
}

interface LookRow extends LookSourceRow {
  label: string;
  preset: string | null;
  prompt: string | null;
  targetAge: number | null;
  sourceLookId: string | null;
  photoUrl: string | null;
  error: string | null;
  createdAt: Date;
  activeSketch?: { url: string | null } | null;
}

export interface PersonaLookQuotaView {
  dayUsed: number;
  dayLimit: number;
  monthUsed: number;
  monthLimit: number;
}

export type CreatedPersonaLook = PersonaLookView & {
  /** Сдвиг возраста больше 20 лет — сходство может упасть (§4.4). */
  warning?: PersonaLookWarning;
};

function disabled(): NotFoundException {
  return new NotFoundException({
    code: 'PERSONA_DISABLED',
    message: 'Режим «Я в кадре» недоступен',
  });
}

@Injectable()
export class PersonaLooksService implements PersonaLookGenerator {
  private readonly logger = new Logger(PersonaLooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly aiUsage: AiUsageService,
    private readonly blob: BlobService,
    private readonly settings: PlatformSettingsService,
    private readonly generator: SketchGeneratorService,
  ) {}

  // ── Квота ─────────────────────────────────────────────────────────

  async quotaLimits(userId: string): Promise<PersonaLookQuota> {
    const plan = (await this.plans.planOfUser(userId)) as PlanId;
    const keys = PERSONA_LOOK_QUOTA_SETTING_KEYS[plan];
    const [day, month] = await Promise.all([
      this.settings.get(keys.day),
      this.settings.get(keys.month),
    ]);
    return personaLookQuotaFor(plan, { day, month });
  }

  async quota(
    userId: string,
    now: Date = new Date(),
  ): Promise<PersonaLookQuotaView> {
    const limits = await this.quotaLimits(userId);
    const [dayUsed, monthUsed] = await Promise.all([
      this.aiUsage.countToday(userId, PERSONA_LOOK_OPERATION, now),
      this.aiUsage.countSince(
        userId,
        PERSONA_LOOK_OPERATION,
        startOfMonthUtc(now),
      ),
    ]);
    return {
      dayUsed,
      dayLimit: limits.day,
      monthUsed,
      monthLimit: limits.month,
    };
  }

  /** Для `GET /personas/me` (шов `PersonaLookGenerator`). */
  async quotaLeft(
    userId: string,
  ): Promise<{ dayLeft: number; monthLeft: number }> {
    const q = await this.quota(userId);
    return {
      dayLeft: Math.max(0, q.dayLimit - q.dayUsed),
      monthLeft: Math.max(0, q.monthLimit - q.monthUsed),
    };
  }

  // ── Маршруты ──────────────────────────────────────────────────────

  /**
   * Новый образ. Порядок проверок — от «нельзя вообще» к «нельзя сейчас»
   * и от дешёвых к дорогим: режим и персона → тариф → текст → источник →
   * возраст → бронь квоты → модель.
   */
  async create(
    userId: string,
    dto: CreatePersonaLookDto,
  ): Promise<CreatedPersonaLook> {
    const persona = await this.requireVerifiedPersona(userId);
    await this.plans.assertUser(userId, 'personalBrand');
    await this.plans.assertCanSpendUser(userId);

    const description = dto.description?.trim()
      ? sanitizeSketchDescription(dto.description).slice(0, 500)
      : null;
    if (
      !dto.preset &&
      !description &&
      dto.targetAge === undefined &&
      !dto.sourceLookId
    ) {
      throw new BadRequestException(
        'Выберите пресет, опишите образ словами или задайте возраст',
      );
    }
    const likeness = findCelebrityLikeness(description);
    if (likeness) {
      throw new BadRequestException(celebrityLikenessMessage(likeness));
    }

    const requested = dto.sourceLookId
      ? ((await this.prisma.personaLook.findFirst({
          where: { id: dto.sourceLookId, personaId: persona.id },
        })) as LookRow | null)
      : null;
    const baseLook = await this.baseLookOf(persona.id);
    const source = resolveLookSource({
      persona,
      base: false,
      requested,
      requestedId: dto.sourceLookId ?? null,
      baseLook,
    });
    if (!source.ok) {
      throw new BadRequestException(LOOK_SOURCE_REFUSAL_MESSAGE[source.reason]);
    }

    // Возраст образа-источника (или середина оценки селфи) — от него и
    // сдвиг, и возраст по умолчанию. Т-6: итог всегда 18…90.
    const sourceLook =
      source.lookId === requested?.id
        ? requested
        : source.lookId === baseLook?.id
          ? baseLook
          : null;
    const reference = referenceLookAge({
      sourceTargetAge: sourceLook?.targetAge ?? null,
      ageMin: persona.ageMin,
      ageMax: persona.ageMax,
    });
    const targetAge = resolveLookAge(dto.targetAge, reference);
    if (targetAge === null || !isLookAge(targetAge)) {
      throw new BadRequestException('Возраст образа — от 18 до 90 лет');
    }
    const warning = lookAgeWarning(targetAge, reference);

    const row = (await this.prisma.personaLook.create({
      data: {
        personaId: persona.id,
        label: defaultLookLabel(description),
        preset: dto.preset ?? null,
        prompt: description,
        targetAge,
        // NULL — из селфи; иначе образ-источник (в т.ч. базовый после
        // удаления селфи по сроку, В-3) — так генерация найдёт тот же файл.
        sourceLookId: source.lookId,
        isBase: false,
        status: 'pending',
      },
    })) as LookRow;

    const exhausted = await this.exhaustedWithReservations(
      userId,
      persona.id,
      row.id,
    );
    if (exhausted) {
      // Бронь не пригодилась — убираем, чтобы не держала лимит.
      await this.prisma.personaLook.deleteMany({
        where: { id: row.id, status: 'pending' },
      });
      throw new HttpException(
        {
          message:
            exhausted.kind === 'day'
              ? `Лимит новых образов на сегодня исчерпан (${exhausted.quota.dayLimit}). Обновится в 00:00 UTC (03:00 по Киеву).`
              : `Лимит новых образов в этом месяце исчерпан (${exhausted.quota.monthLimit}).`,
          code: 'PERSONA_LOOK_QUOTA',
          quota: await this.quotaLeft(userId),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      await this.generateLookImage(row.id, { base: false });
    } catch (error) {
      // Неудачный образ в списке человеку не нужен: причину он получил
      // ответом, а строка без картинки — только мусор в галерее.
      await this.prisma.personaLook
        .updateMany({
          where: { id: row.id, deletedAt: null },
          data: { deletedAt: new Date() },
        })
        .catch(() => undefined);
      throw error;
    }

    const ready = (await this.prisma.personaLook.findUnique({
      where: { id: row.id },
      include: { activeSketch: true },
    })) as LookRow;
    return {
      ...personaLookToDto(ready),
      ...(warning ? { warning } : {}),
    };
  }

  async rename(
    userId: string,
    lookId: string,
    label: string,
  ): Promise<PersonaLookView> {
    const look = await this.ownLook(userId, lookId);
    const clean = sanitizeSketchDescription(label).slice(0, 80);
    if (!clean) {
      throw new BadRequestException('Название образа не может быть пустым');
    }
    const row = (await this.prisma.personaLook.update({
      where: { id: look.id },
      data: { label: clean },
      include: { activeSketch: true },
    })) as LookRow;
    return personaLookToDto(row);
  }

  /**
   * Удаление образа: ФАЙЛЫ — фото образа и все его скетчи — удаляются
   * сразу (согласие обещает удаление лица, CONTRACT5 п.9); строка
   * остаётся мягко удалённой — на неё могут ссылаться бриф и бренд-бук.
   * Снимки уже снятых сессий держат копию URL и потеряют превью — это
   * принятая цена обещания.
   *
   * Сначала файлы, потом строка: не удался хоть один файл — 503 и строка
   * жива, повтор доделает. Наоборот было бы хуже — образ исчез бы из
   * списка, а лицо осталось бы в хранилище без кнопки «удалить».
   *
   * Работает и при выключенном `PERSONA_ENABLED` — право на удаление.
   * Базовый образ отдельно не удаляется: после удаления селфи по сроку
   * (В-3) он — единственный источник новых образов; убрать его можно
   * только вместе с персоной (`DELETE /personas/me`).
   */
  async remove(userId: string, lookId: string): Promise<{ ok: true }> {
    const look = await this.ownLook(userId, lookId, { allowDisabled: true });
    if (look.isBase) {
      throw new BadRequestException(
        'Базовый образ — источник новых образов; он удаляется только вместе с персоной',
      );
    }
    const sketches = (await this.prisma.imageSketch.findMany({
      where: {
        userId,
        targetType: 'persona-look',
        targetId: look.id,
        pathname: { not: null },
      },
      select: { id: true, pathname: true },
    })) as Array<{ id: string; pathname: string | null }>;
    const files = [
      look.photoPathname,
      ...sketches.map((s) => s.pathname),
    ].filter((p): p is string => !!p);
    const results = await Promise.all(
      files.map((p) => this.blob.deleteBlob(p).catch(() => false)),
    );
    if (results.some((ok) => ok !== true)) {
      throw new ServiceUnavailableException(
        'Не удалось удалить файлы образа — попробуйте ещё раз',
      );
    }
    if (sketches.length > 0) {
      await this.prisma.imageSketch.updateMany({
        where: { id: { in: sketches.map((s) => s.id) } },
        data: {
          status: 'superseded',
          pathname: null,
          url: null,
          expiresAt: null,
        },
      });
    }
    await this.prisma.personaLook.updateMany({
      where: { id: look.id, deletedAt: null },
      data: {
        deletedAt: new Date(),
        photoPathname: null,
        photoUrl: null,
        activeSketchId: null,
      },
    });
    return { ok: true };
  }

  /** `GET /personas/voice-consent-phrase?locale=` (§4.6). */
  async voiceConsentPhrase(
    userId: string,
    locale: string | undefined,
  ): Promise<PersonaVoiceConsentPhrase> {
    if (!personaModeEnabled()) throw disabled();
    const user = (await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true },
    })) as { firstName: string | null } | null;
    return personaVoiceConsentPhrase(locale, user?.firstName ?? null);
  }

  // ── Генерация (шов PersonaLookGenerator) ──────────────────────────

  /**
   * Картинка уже созданной строки `pending`. Базовый образ — из селфи,
   * квоту не тратит (операция `persona-look-base`). Успех — `ready` и
   * файл под `users/{userId}/personas/{personaId}/looks/…`; иначе
   * `failed` с причиной и исключение.
   */
  async generateLookImage(
    lookId: string,
    opts: { base: boolean },
  ): Promise<void> {
    const look = (await this.prisma.personaLook.findUnique({
      where: { id: lookId },
      include: { persona: true },
    })) as (LookRow & { persona: PersonaRow }) | null;
    if (!look || look.deletedAt) {
      throw new NotFoundException('Образ не найден');
    }
    const persona = look.persona;
    const fail = async (message: string): Promise<void> => {
      await this.prisma.personaLook.update({
        where: { id: look.id },
        data: { status: 'failed', error: message.slice(0, 500) },
      });
    };
    if (persona.revokedAt) {
      await fail('Персона удалена');
      throw new NotFoundException('Персона удалена');
    }
    // Базовый образ E зовёт посреди проверки — там персона только что
    // её прошла; остальным образам нужна персона с действующим допуском.
    if (!opts.base && !personaSelfLikenessEligible(persona)) {
      await fail('Проверка селфи не пройдена');
      throw new ForbiddenException(
        'Образы доступны после согласия и проверки селфи',
      );
    }

    const requested = look.sourceLookId
      ? ((await this.prisma.personaLook.findFirst({
          where: { id: look.sourceLookId, personaId: persona.id },
        })) as LookRow | null)
      : null;
    // Запасной источник нужен только образу «из селфи», когда селфи уже
    // удалено по сроку (В-3); решает `resolveLookSource`, здесь — чтение.
    const baseLook =
      opts.base || look.sourceLookId ? null : await this.baseLookOf(persona.id);
    const source = resolveLookSource({
      persona,
      base: opts.base,
      requested,
      requestedId: opts.base ? null : look.sourceLookId,
      baseLook,
    });
    if (!source.ok) {
      const message = LOOK_SOURCE_REFUSAL_MESSAGE[source.reason];
      await fail(message);
      throw new BadRequestException(message);
    }

    const targetAge =
      look.targetAge !== null && isLookAge(look.targetAge)
        ? look.targetAge
        : referenceLookAge({
            sourceTargetAge: requested?.targetAge ?? null,
            ageMin: persona.ageMin,
            ageMax: persona.ageMax,
          });
    const prompt = buildPersonaLookPrompt({
      base: opts.base,
      preset: opts.base ? null : (look.preset as never),
      description: opts.base ? null : look.prompt,
      targetAge,
    });

    let bytes: Buffer;
    try {
      bytes = await this.blob.downloadBuffer(source.pathname);
    } catch (error) {
      const message = 'Не удалось прочитать исходное фото образа';
      this.logger.warn(
        `образ ${look.id}: ${message} — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await fail(message);
      throw new HttpException(message, HttpStatus.BAD_GATEWAY);
    }

    const outcome = await this.generator.generate({
      prompt,
      source: {
        bytes,
        mimeType: mimeOfPathname(source.pathname) ?? 'image/jpeg',
      },
      model: GEMINI_IMAGE_MODEL,
    });

    if (outcome.status === 'failed') {
      // Ответа не было — вызов не оплачен, расход не пишем.
      await fail(`Не удалось сгенерировать образ: ${outcome.reason}`);
      throw new HttpException(
        `Не удалось сгенерировать образ: ${outcome.reason}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    await this.aiUsage.recordGemini(outcome.raw, {
      operation: opts.base ? 'persona-look-base' : PERSONA_LOOK_OPERATION,
      model: outcome.model,
      userId: persona.userId,
    });

    if (outcome.status === 'refused') {
      const message =
        'Модель отказалась рисовать этот образ. Попробуйте другое описание или пресет.';
      await fail(message);
      throw new HttpException(message, HttpStatus.UNPROCESSABLE_ENTITY);
    }

    const pathname = lookPhotoPathname(
      persona.userId,
      persona.id,
      look.id,
      outcome.mimeType,
    );
    const { url } = await this.blob.uploadBuffer(
      pathname,
      outcome.bytes,
      outcome.mimeType,
    );
    await this.prisma.personaLook.update({
      where: { id: look.id },
      data: {
        status: 'ready',
        error: null,
        photoPathname: pathname,
        photoUrl: url,
        // Т-6: у образа всегда есть возраст из 18…90 — и у базового тоже.
        targetAge,
      },
    });
  }

  // ── Внутреннее ────────────────────────────────────────────────────

  /**
   * Персона с действующим согласием и пройденной проверкой — та же
   * граница, что у своего лица в скетче (`personaSelfLikenessEligible`).
   */
  private async requireVerifiedPersona(userId: string): Promise<PersonaRow> {
    if (!personaModeEnabled()) throw disabled();
    const persona = (await this.prisma.persona.findFirst({
      where: { userId, revokedAt: null },
    })) as PersonaRow | null;
    if (!persona) {
      throw new NotFoundException(
        'Сначала создайте себя в разделе «Я в кадре»',
      );
    }
    if (!personaSelfLikenessEligible(persona)) {
      throw new ForbiddenException(
        'Образы доступны после согласия и проверки селфи',
      );
    }
    return persona;
  }

  /** Живой образ своей (не отозванной) персоны; чужой и несуществующий — 404. */
  private async ownLook(
    userId: string,
    lookId: string,
    opts: { allowDisabled?: boolean } = {},
  ): Promise<LookRow> {
    if (!opts.allowDisabled && !personaModeEnabled()) throw disabled();
    const look = (await this.prisma.personaLook.findFirst({
      where: {
        id: lookId,
        deletedAt: null,
        persona: { userId, revokedAt: null },
      },
    })) as LookRow | null;
    if (!look) throw new NotFoundException('Образ не найден');
    return look;
  }

  private async baseLookOf(personaId: string): Promise<LookRow | null> {
    return (await this.prisma.personaLook.findFirst({
      where: { personaId, isBase: true, deletedAt: null, status: 'ready' },
      orderBy: { createdAt: 'desc' },
    })) as LookRow | null;
  }

  /**
   * Квота с учётом живых броней: своя бронь уже создана, проходят
   * первые N по времени создания (тот же приём, что `quotaWithReservations`
   * скетча). Базовый образ бронью не считается — квоту он не тратит.
   */
  private async exhaustedWithReservations(
    userId: string,
    personaId: string,
    ownId: string,
    now: Date = new Date(),
  ): Promise<{ kind: 'day' | 'month'; quota: PersonaLookQuotaView } | null> {
    const base = await this.quota(userId, now);
    const live = (await this.prisma.personaLook.findMany({
      where: {
        personaId,
        isBase: false,
        status: 'pending',
        deletedAt: null,
        createdAt: {
          gt: new Date(now.getTime() - PERSONA_LOOK_RESERVATION_TTL_MS),
        },
      },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
    })) as Array<{ id: string }>;
    const rank = live.findIndex((r) => r.id === ownId);
    const ahead = rank < 0 ? live.length : rank;
    const kind = exhaustedQuota(
      { dayUsed: base.dayUsed + ahead, monthUsed: base.monthUsed + ahead },
      { day: base.dayLimit, month: base.monthLimit },
    );
    return kind ? { kind, quota: base } : null;
  }
}
