/**
 * PersonaService — режим «Я в кадре», серверное ядро (этап E ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §4.1–4.4, §4.9,
 * §4.10): согласие, загрузка селфи и ролика живости, автопроверка
 * одним мультимодальным вызовом Gemini, базовый образ, отзыв и удаление,
 * срок хранения источников (В-3).
 *
 * Образы сверх базового, квота, скетч и голос персоны — у F (свои файлы
 * этого же модуля и `user-voices`); здесь только швы к ним
 * (`persona-look-generator.ts`).
 *
 * Режим за рубильником `PERSONA_ENABLED` (юридический шлюз §4.10):
 * выключен — создание, проверка и генерация отвечают 404
 * `PERSONA_DISABLED`. Удаление и просмотр УЖЕ существующей персоны
 * работают и при выключенном рубильнике (CONTRACT5, п.8): право на
 * удаление не должно зависеть от того, открыт ли режим.
 */

import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { Persona } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { createGeminiClient, geminiApiKey } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { pathnameFromBlobUrl } from '../../common/blob-paths';
import {
  UserVoicesService,
  forgetVoiceInBrandManifests,
} from '../user-voices/user-voices.service';
import { PlanService } from '../plan/plan.service';
import { ResembleService } from '../tts/resemble.service';
import { checkFaces, FaceCheckGenerator, FaceCheckResult } from './face-check';
import { personaConsentText, PERSONA_CONSENT_VERSION } from './persona-consent';
import {
  dropSourcesAfterRefusal,
  keepAgeEstimate,
  livenessPathname,
  mimeOfPathname,
  personaAbandonedCutoff,
  personaBlobPrefix,
  personaDisabledError,
  personaEnabled,
  personaRefusals,
  personaSourcesCutoff,
  serverSourcePathname,
  PERSONA_DEFAULT_LIVENESS_MIME,
  PERSONA_DEFAULT_SELFIE_MIME,
  PERSONA_LIVENESS_MAX_BYTES,
  PERSONA_SELFIE_MAX_BYTES,
  selfiePathname,
} from './persona-rules';
import {
  BASE_LOOK_GENERATOR_MISSING,
  PERSONA_LOOK_GENERATOR,
  PERSONA_SHARES_LOOKUP,
  PersonaLookGenerator,
  PersonaShare,
  PersonaSharesLookup,
} from './persona-look-generator';
import {
  CreatePersonaResult,
  DeletePersonaResult,
  PersonaMeView,
  PersonaView,
  personaLookToDto,
  PersonaLookView,
  refusalsOf,
  StoredVerifyResult,
  VerifyPersonaResult,
} from './persona-view';
import type { CreatePersonaDto } from './dto/persona.dto';

/**
 * Базовых генераций в сутки UTC на человека — первая при проверке плюс
 * пять перегенераций. Квоту образов они не тратят (В-7 — про новые
 * образы), поэтому потолок свой.
 */
export const PERSONA_BASE_GENERATIONS_PER_DAY = 6;

/** Персон за одну выборку крона хранения. */
export const PERSONA_RETENTION_BATCH = 100;
/** Выборок одного вида за прогон — потолок работы одного вызова крона. */
export const PERSONA_RETENTION_MAX_BATCHES = 10;

export const PERSONA_UNDER_18_MESSAGE =
  'Режим недоступен по оценке возраста. Если оценка ошибочна, напишите в поддержку.';

export interface PersonaRetentionResult {
  /** Проверенных персон, чьи селфи и ролик удалены по сроку (В-3). */
  purged: number;
  /** Незавершённых попыток, чьи файлы удалены. */
  abandoned: number;
  /** Отозванных персон, чьё удаление дочищено (сбой файлов при DELETE). */
  erased: number;
  /** Персон, у которых хранилище не приняло удаление, — повтор на следующем прогоне. */
  failed: number;
  /** Удалений клонов у Resemble, повторённых из списка ожидания. */
  resembleRetried?: number;
  skipped?: boolean;
}

/**
 * Надгробие «младше 18» (CONTRACT5, п.3): строка остаётся с `revokedAt`
 * и отказом `under-18`, файлы удалены. Держит отказ: новый `POST
 * /personas` отвечает 403, а не заводит попытку заново (В-4: апелляция —
 * через поддержку, не пересъёмкой).
 */
export function isUnder18Tombstone(p: {
  revokedAt: Date | null;
  verifyResult: unknown;
}): boolean {
  return (
    p.revokedAt !== null &&
    (refusalsOf(p.verifyResult)?.includes('under-18') ?? false)
  );
}

@Injectable()
export class PersonaService {
  private readonly logger = new Logger(PersonaService.name);
  private readonly genai: FaceCheckGenerator | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly aiUsage: AiUsageService,
    private readonly moduleRef: ModuleRef,
    private readonly plans: PlanService,
  ) {
    this.genai = geminiApiKey() ? createGeminiClient() : null;
  }

  /**
   * Швы к F и G — лениво через `ModuleRef`, а не конструктором: генератор
   * образов F сам зависит от `PersonaService` (`requireVerifiedPersona`),
   * и инъекция в конструктор замкнула бы цикл провайдеров. Не
   * зарегистрирован — `null`, и сервис ведёт себя честно (см. токены).
   */
  private get looks(): PersonaLookGenerator | null {
    return this.optional<PersonaLookGenerator>(PERSONA_LOOK_GENERATOR);
  }

  private get shares(): PersonaSharesLookup | null {
    return this.optional<PersonaSharesLookup>(PERSONA_SHARES_LOOKUP);
  }

  private optional<T>(token: string): T | null {
    try {
      return this.moduleRef.get<T>(token, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

  // ── Рубильник и доступ ────────────────────────────────────────────────

  assertEnabled(): void {
    if (!personaEnabled()) throw personaDisabledError();
  }

  /** Живая персона пользователя или 404. */
  async requirePersona(userId: string): Promise<Persona> {
    this.assertEnabled();
    const persona = await this.prisma.persona.findUnique({
      where: { userId },
    });
    if (!persona || persona.revokedAt) {
      throw new NotFoundException({
        code: 'PERSONA_NOT_FOUND',
        message: 'Персона не создана',
      });
    }
    return persona;
  }

  /**
   * Для образов и скетча `likeness: 'self'` (F): персона с пройденной
   * проверкой. Не пройдена — 403: без неё образ был бы изображением
   * непроверенного лица (§4.5).
   */
  async requireVerifiedPersona(userId: string): Promise<Persona> {
    const persona = await this.requirePersona(userId);
    if (!persona.livenessCheckedAt) {
      throw new ForbiddenException({
        code: 'PERSONA_NOT_VERIFIED',
        message: 'Сначала пройдите проверку селфи',
      });
    }
    return persona;
  }

  consentText(locale: string | undefined) {
    this.assertEnabled();
    return personaConsentText(locale);
  }

  // ── POST /personas ────────────────────────────────────────────────────

  /**
   * Согласие → строка персоны → ссылки на загрузку. Согласие пишется ДО
   * выдачи ссылок (§4.3: без согласия записи нет, камера — после галочки).
   *
   * Одна персона на аккаунт (§4.2): проверенная — 409. Непроверенная
   * (бросил на середине, отказ за свет) — та же строка, свежие ссылки и
   * свежее согласие: вторая «я» так не появляется, а пересъёмка не
   * упирается в 409. Закрытая по возрасту — 403 (В-4: апелляция через
   * поддержку, не пересъёмкой).
   */
  async create(
    userId: string,
    dto: CreatePersonaDto,
  ): Promise<CreatePersonaResult> {
    this.assertEnabled();
    if (dto.consent !== true) {
      throw new BadRequestException('Нужно согласие');
    }
    if (dto.consentTextVersion !== PERSONA_CONSENT_VERSION) {
      throw new ConflictException({
        code: 'PERSONA_CONSENT_OUTDATED',
        message: 'Текст согласия обновился — перечитайте его',
        version: PERSONA_CONSENT_VERSION,
      });
    }
    const consent = personaConsentText(dto.locale);
    const selfieMime = dto.selfieMimeType ?? PERSONA_DEFAULT_SELFIE_MIME;
    const livenessMime = dto.livenessMimeType ?? PERSONA_DEFAULT_LIVENESS_MIME;

    const existing = await this.prisma.persona.findUnique({
      where: { userId },
    });
    if (existing && refusalsOf(existing.verifyResult)?.includes('under-18')) {
      throw new ForbiddenException({
        code: 'PERSONA_UNDER_18',
        message: PERSONA_UNDER_18_MESSAGE,
      });
    }
    if (existing?.revokedAt) {
      // Удаление началось, но хранилище приняло не все файлы: строку
      // дочищает крон хранения. Новую попытку поверх недоудалённой не
      // заводим — иначе её файлы смешались бы с файлами прежней.
      throw new ConflictException({
        code: 'PERSONA_DELETE_PENDING',
        message:
          'Прежние данные ещё удаляются. Попробуйте через несколько минут.',
      });
    }
    if (existing?.livenessCheckedAt) {
      throw new ConflictException({
        code: 'PERSONA_EXISTS',
        message: 'Персона уже создана',
      });
    }

    const now = new Date();
    const consentData = {
      consentGivenAt: now,
      consentText: consent.text,
      consentTextVersion: consent.version,
    };
    let persona: Persona;
    if (existing) {
      // Старые файлы незавершённой попытки — удалить: новые пути другие
      // (случайный хвост), и прежние стали бы сиротами с лицом.
      await this.dropSources(existing);
      persona = await this.prisma.persona.update({
        where: { id: existing.id },
        data: {
          ...consentData,
          // Прежний отказ (свет, поворот) к новой попытке не относится.
          verifyResult: Prisma.DbNull,
          ageMin: null,
          ageMax: null,
          ageEstimatedAt: null,
        },
      });
    } else {
      try {
        persona = await this.prisma.persona.create({
          data: { userId, ...consentData },
        });
      } catch (e) {
        // Гонка двух вкладок: `userId @unique` пропустил одну.
        if ((e as { code?: string })?.code === 'P2002') {
          throw new ConflictException({
            code: 'PERSONA_EXISTS',
            message: 'Персона уже создана',
          });
        }
        throw e;
      }
    }

    const nonce = randomBytes(12).toString('hex');
    const selfie = selfiePathname(userId, persona.id, selfieMime, nonce);
    const liveness = livenessPathname(userId, persona.id, livenessMime, nonce);
    await this.prisma.persona.update({
      where: { id: persona.id },
      data: { selfiePathname: selfie, livenessPathname: liveness },
    });
    const [s, l] = await Promise.all([
      this.blob.createUploadUrl(selfie, selfieMime, PERSONA_SELFIE_MAX_BYTES),
      this.blob.createUploadUrl(
        liveness,
        livenessMime,
        PERSONA_LIVENESS_MAX_BYTES,
      ),
    ]);
    return {
      personaId: persona.id,
      selfieUploadUrl: s.uploadUrl,
      selfiePathname: selfie,
      livenessUploadUrl: l.uploadUrl,
      livenessPathname: liveness,
    };
  }

  // ── POST /personas/me/verify ──────────────────────────────────────────

  /**
   * Автопроверка (§4.3, §4.4) и базовый образ (§4.1 п.4).
   *
   * Повторный вызов после успеха — тот же ответ без нового платного
   * вызова. Закрытая по возрасту персона — отказ `under-18` без вызова.
   */
  async verify(userId: string): Promise<VerifyPersonaResult> {
    this.assertEnabled();
    const row = await this.prisma.persona.findUnique({ where: { userId } });
    if (row && isUnder18Tombstone(row)) return under18Answer(row);
    const persona = await this.requirePersona(userId);

    if (persona.livenessCheckedAt) return this.verifiedAnswer(persona);
    if (!persona.selfiePathname || !persona.livenessPathname) {
      throw new ConflictException({
        code: 'PERSONA_UPLOAD_MISSING',
        message: 'Снимите селфи и ролик заново',
      });
    }

    const [selfie, liveness] = await Promise.all([
      this.readSource(persona.selfiePathname, PERSONA_SELFIE_MAX_BYTES),
      this.readSource(persona.livenessPathname, PERSONA_LIVENESS_MAX_BYTES),
    ]);
    if (!selfie || !liveness) {
      throw new BadRequestException({
        code: 'PERSONA_UPLOAD_MISSING',
        message: 'Селфи или ролик не загружены — снимите заново',
      });
    }
    // Платный мультимодальный вызов — под общим правилом трат (§26.4):
    // блокировка оператором и дневной лимит аккаунта (CONTRACT5, п.11).
    await this.plans.assertCanSpendUser(userId);

    const result = await checkFaces(
      this.genai,
      { purpose: 'persona', photo: selfie, liveness },
      {
        model: GEMINI_MODEL,
        onResponse: (res) =>
          this.aiUsage.recordGemini(res, {
            operation: 'persona-verify',
            model: GEMINI_MODEL,
            userId,
          }),
      },
    );
    const reasons = personaRefusals(result);
    const now = new Date();
    const stored = storedResult(result, reasons, now);
    // Приватность (§4.4): оценка возраста — только в этих колонках, только
    // для допуска к режиму и показа человеку; не в журнал, не в аналитику.
    const age =
      result?.ageMin !== undefined &&
      result?.ageMax !== undefined &&
      keepAgeEstimate(reasons)
        ? { ageMin: result.ageMin, ageMax: result.ageMax, ageEstimatedAt: now }
        : { ageMin: null, ageMax: null, ageEstimatedAt: null };

    if (reasons.includes('under-18')) {
      // Надгробие (CONTRACT5, п.3): строка остаётся отозванной, файлы —
      // удаляются сразу; не удалились — пути остаются в строке, и их
      // дочищает крон хранения.
      await this.prisma.persona.update({
        where: { id: persona.id },
        data: { verifyResult: stored as object, ...age, revokedAt: now },
      });
      await this.cleanTombstone(persona, now);
      return {
        status: 'refused',
        reasons,
        ...(age.ageMin !== null && age.ageMax !== null
          ? { ageMin: age.ageMin, ageMax: age.ageMax }
          : {}),
      };
    }

    if (reasons.length > 0) {
      await this.prisma.persona.update({
        where: { id: persona.id },
        data: { verifyResult: stored as object, ...age },
      });
      if (dropSourcesAfterRefusal(reasons)) await this.dropSources(persona);
      return {
        status: 'refused',
        reasons,
        ...(age.ageMin !== null && age.ageMax !== null
          ? { ageMin: age.ageMin, ageMax: age.ageMax }
          : {}),
      };
    }

    // Проверенные байты — в пути, которым владеет сервер (CONTRACT5, п.1),
    // ДО того, как персона станет проверенной: не записалось — проверка
    // не засчитана, повтор возможен с теми же файлами.
    const moved = await this.copyToServerPaths(userId, persona.id, {
      selfie,
      liveness,
    });

    // Условное обновление: из двух одновременных проверок базовый образ
    // заводит одна — вторая увидит уже проверенную персону.
    // `revokedAt: null` — одновременный DELETE: отозванную персону
    // проверенной не делаем (иначе копии с лицом легли бы в строку,
    // которую удаление уже обошло).
    const claimed = await this.prisma.persona.updateMany({
      where: { id: persona.id, livenessCheckedAt: null, revokedAt: null },
      data: {
        livenessCheckedAt: now,
        verifyResult: stored as object,
        ...age,
        selfiePathname: moved.selfiePathname,
        livenessPathname: moved.livenessPathname,
      },
    });
    if (claimed.count === 0) {
      // Проиграли гонку (вторая проверка или удаление) — наши копии не
      // записаны ни в одну строку и никому не нужны.
      await this.blob.deleteMany([
        moved.selfiePathname,
        moved.livenessPathname,
      ]);
      const other = await this.prisma.persona.findUnique({
        where: { id: persona.id },
      });
      if (!other || other.revokedAt) {
        throw new NotFoundException({
          code: 'PERSONA_NOT_FOUND',
          message: 'Персона не создана',
        });
      }
      return this.verifiedAnswer(other);
    }
    const fresh = await this.prisma.persona.findUniqueOrThrow({
      where: { id: persona.id },
    });
    // Клиентские пути больше не читаются никем; их ссылка на загрузку ещё
    // может быть жива — удаляем, чтобы подмена ни на что не влияла.
    const clientPaths = [persona.selfiePathname, persona.livenessPathname];
    const sent = await this.blob.deleteMany(clientPaths);
    if (sent < clientPaths.length) {
      this.logger.warn(
        `персона ${persona.id}: клиентские копии селфи/ролика не удалены — их снимет удаление персоны (префикс)`,
      );
    }

    const look = await this.prisma.personaLook.create({
      // Подпись пустая: клиент показывает «Базовый образ» на языке
      // интерфейса по `isBase`, человек может переименовать.
      data: { personaId: persona.id, label: '', isBase: true },
    });
    // Базовый образ из проверки входит в тот же суточный потолок базовых
    // генераций, что и «перегенерировать» (CONTRACT5, п.11): иначе цикл
    // «удалить себя → снять заново» был бы бесплатной генерацией картинок.
    if (await this.baseGenerationsExhausted(userId)) {
      await this.failLook(look.id, BASE_GENERATIONS_EXHAUSTED);
    } else {
      await this.generateBase(look.id);
    }
    return this.verifiedAnswer(fresh);
  }

  private async baseGenerationsExhausted(userId: string): Promise<boolean> {
    const today = await this.aiUsage.countToday(userId, 'persona-look-base');
    return today >= PERSONA_BASE_GENERATIONS_PER_DAY;
  }

  /**
   * Копия проверенных байтов в серверные пути. Бросает 503: без копии
   * проверку засчитывать нельзя — образы делались бы из клиентского пути,
   * который клиент может перезаписать.
   */
  private async copyToServerPaths(
    userId: string,
    personaId: string,
    src: {
      selfie: { data: Buffer; mimeType: string };
      liveness: { data: Buffer; mimeType: string };
    },
  ): Promise<{ selfiePathname: string; livenessPathname: string }> {
    const nonce = randomBytes(12).toString('hex');
    const selfiePathname = serverSourcePathname(
      userId,
      personaId,
      'selfie',
      src.selfie.mimeType,
      nonce,
    );
    const livenessPathname = serverSourcePathname(
      userId,
      personaId,
      'liveness',
      src.liveness.mimeType,
      nonce,
    );
    try {
      await this.blob.uploadBuffer(
        selfiePathname,
        src.selfie.data,
        src.selfie.mimeType,
      );
      await this.blob.uploadBuffer(
        livenessPathname,
        src.liveness.data,
        src.liveness.mimeType,
      );
    } catch (e) {
      this.logger.warn(
        `персона ${personaId}: копия источников не записана: ${e instanceof Error ? e.message : String(e)}`,
      );
      await this.blob.deleteMany([selfiePathname, livenessPathname]);
      throw new ServiceUnavailableException({
        code: 'PERSONA_STORAGE_UNAVAILABLE',
        message: 'Хранилище временно недоступно — повторите проверку позже',
      });
    }
    return { selfiePathname, livenessPathname };
  }

  private async verifiedAnswer(persona: Persona): Promise<VerifyPersonaResult> {
    const base = await this.prisma.personaLook.findFirst({
      where: { personaId: persona.id, isBase: true, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { activeSketch: { select: { url: true } } },
    });
    return {
      status: 'ok',
      ...(persona.ageMin !== null && persona.ageMax !== null
        ? { ageMin: persona.ageMin, ageMax: persona.ageMax }
        : {}),
      ...(base ? { baseLook: personaLookToDto(base) } : {}),
    };
  }

  /**
   * Картинка базового образа — генератором F. Нет генератора или он
   * упал — образ `failed` с причиной, а проверка остаётся пройденной:
   * перегенерировать можно, переснимать селфи незачем.
   */
  private async generateBase(lookId: string): Promise<void> {
    const looks = this.looks;
    if (!looks) {
      await this.failLook(lookId, BASE_LOOK_GENERATOR_MISSING);
      return;
    }
    try {
      await looks.generateLookImage(lookId, { base: true });
    } catch (e) {
      this.logger.warn(
        `базовый образ ${lookId} не создан: ${e instanceof Error ? e.message : String(e)}`,
      );
      await this.failLook(lookId, 'Не удалось создать базовый образ');
    }
  }

  private async failLook(lookId: string, error: string): Promise<void> {
    await this.prisma.personaLook.updateMany({
      where: { id: lookId, status: 'pending' },
      data: { status: 'failed', error },
    });
  }

  // ── POST /personas/me/looks/:id/regenerate ────────────────────────────

  /**
   * «Перегенерировать» базовый образ (§4.1 п.4: принять или
   * перегенерировать). Та же строка образа — ссылки на неё из брифов и
   * личных бренд-буков остаются верными; картинка — тем же генератором F,
   * из селфи.
   *
   * Квоту образов не тратит (как и создание базового), поэтому свой
   * суточный потолок: базовых генераций в сутки UTC не больше
   * `PERSONA_BASE_GENERATIONS_PER_DAY` — считается по журналу расходов
   * (операция `persona-look-base`, её пишет генератор F), куда входит и
   * первая генерация при проверке. Без потолка кнопка была бы бесплатной
   * генерацией картинок без ограничения.
   *
   * Селфи уже удалено по сроку (В-3) — 409: делать «базовый» из самого
   * базового бессмысленно, а из другого источника он перестал бы быть
   * базовым.
   */
  async regenerateBase(
    userId: string,
    lookId: string,
  ): Promise<PersonaLookView> {
    const persona = await this.requireVerifiedPersona(userId);
    const look = await this.prisma.personaLook.findFirst({
      where: { id: lookId, personaId: persona.id, deletedAt: null },
    });
    if (!look) {
      throw new NotFoundException({
        code: 'PERSONA_LOOK_NOT_FOUND',
        message: 'Образ не найден',
      });
    }
    if (!look.isBase) {
      throw new BadRequestException({
        code: 'PERSONA_LOOK_NOT_BASE',
        message:
          'Перегенерировать можно только базовый образ — новый образ создаётся отдельно',
      });
    }
    if (persona.sourcesPurgedAt || !persona.selfiePathname) {
      throw new ConflictException({
        code: 'PERSONA_SOURCES_PURGED',
        message:
          'Селфи уже удалено по сроку хранения, поэтому базовый образ пересоздать нельзя. ' +
          'Чтобы начать заново, удалите себя из режима и снимите селфи ещё раз.',
      });
    }
    if (look.status === 'pending') {
      throw new ConflictException({
        code: 'PERSONA_LOOK_PENDING',
        message: 'Образ ещё создаётся — дождитесь результата',
      });
    }
    await this.plans.assertCanSpendUser(userId);
    if (await this.baseGenerationsExhausted(userId)) {
      throw new HttpException(
        {
          code: 'PERSONA_BASE_REGENERATE_LIMIT',
          message:
            'Базовый образ на сегодня пересоздавался уже много раз — попробуйте завтра',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // Условно: из двух одновременных нажатий генерацию запускает одно.
    const claimed = await this.prisma.personaLook.updateMany({
      where: { id: look.id, status: { not: 'pending' } },
      data: { status: 'pending', error: null },
    });
    if (claimed.count === 0) {
      throw new ConflictException({
        code: 'PERSONA_LOOK_PENDING',
        message: 'Образ ещё создаётся — дождитесь результата',
      });
    }
    await this.generateBase(look.id);
    const fresh = await this.prisma.personaLook.findUniqueOrThrow({
      where: { id: look.id },
      include: { activeSketch: { select: { url: true } } },
    });
    return personaLookToDto(fresh);
  }

  /** Файл источника или `null` (не загружен, больше потолка, неизвестный тип). */
  private async readSource(
    pathname: string,
    maxBytes: number,
  ): Promise<{ data: Buffer; mimeType: string } | null> {
    const mimeType = mimeOfPathname(pathname);
    if (!mimeType) return null;
    const meta = await this.blob.head(pathname);
    if (!meta || meta.size <= 0 || meta.size > maxBytes) return null;
    try {
      return { data: await this.blob.downloadBuffer(pathname), mimeType };
    } catch {
      return null;
    }
  }

  // ── GET /personas/me ──────────────────────────────────────────────────

  async me(userId: string): Promise<PersonaMeView> {
    const enabled = personaEnabled();
    const persona = await this.prisma.persona.findUnique({
      where: { userId },
    });
    // Рубильник выключен и персоны нет — режима для клиента нет вовсе.
    // Персона есть — ответ остаётся: без него не было бы кнопки удаления.
    if (
      !enabled &&
      (!persona || (persona.revokedAt && !isUnder18Tombstone(persona)))
    ) {
      throw personaDisabledError();
    }
    const quota = enabled
      ? await this.quota(userId)
      : { dayLeft: 0, monthLeft: 0 };
    if (!persona) {
      return { persona: null, looks: [], voice: null, quota, enabled };
    }
    if (persona.revokedAt) {
      // Надгробие 18 показывается (экран отказа, без «Начать»); иное
      // отозванное — удаление в процессе, персоны для человека уже нет.
      return {
        persona: isUnder18Tombstone(persona) ? personaToView(persona) : null,
        looks: [],
        voice: null,
        quota,
        enabled,
      };
    }
    const [looks, voice] = await Promise.all([
      this.prisma.personaLook.findMany({
        where: { personaId: persona.id, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        include: { activeSketch: { select: { url: true } } },
      }),
      this.prisma.userVoice.findFirst({
        where: { personaId: persona.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true },
      }),
    ]);
    return {
      persona: personaToView(persona),
      looks: looks.map(personaLookToDto),
      // Нижний регистр — как `toView` в user-voices: клиент сравнивает
      // статус голоса одинаково в обоих местах.
      voice: voice
        ? { id: voice.id, status: String(voice.status).toLowerCase() }
        : null,
      quota,
      enabled,
    };
  }

  private async quota(
    userId: string,
  ): Promise<{ dayLeft: number; monthLeft: number }> {
    const looks = this.looks;
    if (!looks) return { dayLeft: 0, monthLeft: 0 };
    try {
      return await looks.quotaLeft(userId);
    } catch (e) {
      this.logger.warn(
        `квота образов не прочитана: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { dayLeft: 0, monthLeft: 0 };
    }
  }

  // ── DELETE /personas/me ───────────────────────────────────────────────

  /**
   * Отзыв согласия и удаление (§4.9): селфи, ролик, файлы образов,
   * скетчи образов, голос персоны (через `UserVoicesService.remove` —
   * там же удаление у Resemble), сама персона (образы — каскадом).
   * Личные бренд-буки и брифы остаются: ссылки на персону и образы в них
   * обнуляет база (`onDelete: SetNull`). Готовые ролики остаются у автора
   * (снимок сессии — копия образа, §4.8).
   *
   * Работает и при выключенном рубильнике (право на удаление, CONTRACT5
   * п.8).
   *
   * Строка удаляется ТОЛЬКО если хранилище приняло удаление всех файлов
   * (CONTRACT5, п.7). Иначе — 503 `PERSONA_DELETE_INCOMPLETE`, строка
   * остаётся отозванной (`revokedAt`: режимом пользоваться нельзя), и её
   * дочищает крон хранения: строка — единственное, по чему файлы с лицом
   * можно найти (метла `users/` подбирает только удалённых пользователей).
   *
   * Надгробие «младше 18» не удаляется (CONTRACT5, п.3): его файлы
   * удалены при отказе; здесь — только повтор удаления, если тогда
   * хранилище не приняло.
   */
  async remove(userId: string): Promise<DeletePersonaResult> {
    const persona = await this.prisma.persona.findUnique({
      where: { userId },
    });
    if (!persona) {
      throw new NotFoundException({
        code: 'PERSONA_NOT_FOUND',
        message: 'Персона не создана',
      });
    }
    if (isUnder18Tombstone(persona)) {
      if (!(await this.cleanTombstone(persona, new Date()))) {
        throw deleteIncomplete();
      }
      return { publishedSharesWithPersona: [] };
    }
    const published = await this.publishedShares(userId);
    if (!persona.revokedAt) {
      // Сначала отзыв: даже если дальше что-то не удалится, пользоваться
      // режимом (образы, ведущий) уже нельзя.
      await this.prisma.persona.update({
        where: { id: persona.id },
        data: { revokedAt: new Date() },
      });
    }
    if (!(await this.erase(persona))) throw deleteIncomplete();
    return { publishedSharesWithPersona: published };
  }

  /**
   * Удалить всё персоны; `true` — строка удалена, `false` — хранилище
   * приняло не все файлы, строка оставлена (отозванной) для повтора.
   */
  private async erase(persona: Persona): Promise<boolean> {
    const looks = await this.prisma.personaLook.findMany({
      where: { personaId: persona.id },
      select: { id: true, photoPathname: true, photoUrl: true },
    });
    const lookIds = looks.map((l) => l.id);
    const sketches = lookIds.length
      ? await this.prisma.imageSketch.findMany({
          where: { targetType: 'persona-look', targetId: { in: lookIds } },
          select: { id: true, pathname: true },
        })
      : [];

    // Образцы голоса персоны лежат ВНЕ префикса персоны
    // (`users/{u}/voices/{id}/…`), а `UserVoicesService.remove` итог
    // удаления файла не проверяет. Поэтому их файлы — в общий набор ниже,
    // вместе с остальными; строки голосов (и клон у Resemble) снимаются
    // только ПОСЛЕ того, как хранилище приняло все файлы: иначе при сбое
    // повтор уже не знал бы, где лежал образец (аудит проверки).
    const voices = await this.prisma.userVoice.findMany({
      where: { personaId: persona.id },
      select: { id: true, sampleUrl: true },
    });

    const paths = new Set<string>();
    for (const v of voices) {
      const p = pathnameFromBlobUrl(v.sampleUrl, 'users/');
      if (p) paths.add(p);
      const under = await this.listPrefix(
        `users/${persona.userId}/voices/${v.id}/`,
      );
      if (!under) return false;
      for (const x of under) paths.add(x);
    }
    if (persona.selfiePathname) paths.add(persona.selfiePathname);
    if (persona.livenessPathname) paths.add(persona.livenessPathname);
    for (const l of looks) {
      const p = l.photoPathname ?? pathnameFromBlobUrl(l.photoUrl, 'users/');
      if (p) paths.add(p);
    }
    for (const s of sketches) if (s.pathname) paths.add(s.pathname);
    // Всё под префиксом персоны — и то, о чём строки не знают (сорванная
    // генерация, клиентская копия, файл до записи пути). Листинг не удался
    // — удаление не завершено: неизвестно, что под префиксом осталось.
    const listed = await this.listPrefix(
      personaBlobPrefix(persona.userId, persona.id),
    );
    if (!listed) return false;
    for (const p of listed) paths.add(p);
    const list = [...paths];
    const sent = list.length ? await this.blob.deleteMany(list) : 0;
    if (sent < list.length) {
      this.logger.warn(
        `удаление персоны ${persona.id}: хранилище приняло ${sent} из ${list.length} файлов — строка оставлена, дочистит крон`,
      );
      return false;
    }

    await this.removePersonaVoices(persona.userId, persona.id);
    if (sketches.length) {
      await this.prisma.imageSketch.deleteMany({
        where: { id: { in: sketches.map((s) => s.id) } },
      });
    }
    await this.prisma.persona.delete({ where: { id: persona.id } });
    return true;
  }

  private async publishedShares(userId: string): Promise<PersonaShare[]> {
    // Помощник G не зарегистрирован — пустой список: кнопки «снять»
    // не будет, страницы автор снимает вручную в разделе публикаций.
    const shares = this.shares;
    if (!shares) return [];
    try {
      return await shares.publishedSharesWithPersona(userId);
    } catch (e) {
      this.logger.warn(
        `страницы с персоной не прочитаны: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }
  }

  /**
   * Голос персоны — тем же путём, что кнопка «удалить голос»: там и
   * Resemble, и файл образца. `UserVoicesService` берётся через
   * `ModuleRef` без импорта модуля: F правит `user-voices` в этой же
   * волне и может импортировать модуль персоны — прямой импорт замкнул
   * бы цикл. Сервиса нет или он упал — клон удаляется у Resemble здесь
   * же (`deleteVoice` сам ставит неудачу в список повтора), затем образец
   * и строка.
   */
  private async removePersonaVoices(
    userId: string,
    personaId: string,
  ): Promise<void> {
    const voices = await this.prisma.userVoice.findMany({
      where: { personaId },
      select: { id: true, sampleUrl: true, resembleVoiceId: true },
    });
    if (voices.length === 0) return;
    const service = this.optionalClass(UserVoicesService);
    for (const v of voices) {
      try {
        if (!service) throw new Error('UserVoicesService недоступен');
        await service.remove(userId, v.id);
      } catch (e) {
        this.logger.warn(
          `голос персоны ${v.id} удаляется в обход UserVoicesService: ${e instanceof Error ? e.message : String(e)}`,
        );
        if (v.resembleVoiceId) {
          const resemble = this.optionalClass(ResembleService);
          const status = resemble
            ? await resemble.deleteVoice(v.resembleVoiceId)
            : 'failed';
          if (status === 'failed' || status === 'no-key') {
            this.logger.warn(
              `клон Resemble ${v.resembleVoiceId} не удалён (${status}) — в списке повтора`,
            );
          }
        }
        const p = pathnameFromBlobUrl(v.sampleUrl, 'users/');
        if (p) await this.blob.deleteBlob(p);
        await this.prisma.userVoice.deleteMany({ where: { id: v.id } });
        // CONTRACT6 п.4: и в обход сервиса голос уходит из бренд-буков —
        // как в `UserVoicesService.remove`.
        if (v.resembleVoiceId) {
          await forgetVoiceInBrandManifests(
            this.prisma,
            userId,
            v.resembleVoiceId,
          );
        }
      }
    }
  }

  private optionalClass<T>(type: new (...args: never[]) => T): T | null {
    try {
      return this.moduleRef.get(type, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

  /** Все пути под префиксом или `null`, если листинг не удался. */
  private async listPrefix(prefix: string): Promise<string[] | null> {
    const out: string[] = [];
    let cursor: string | undefined;
    try {
      // Под префиксом персоны — единицы/десятки файлов; потолок страниц —
      // от бесконечного цикла при сломанном курсоре.
      for (let page = 0; page < 20; page++) {
        const res = await this.blob.listByPrefix(prefix, { cursor });
        out.push(...res.blobs.map((b) => b.pathname));
        if (!res.cursor) return out;
        cursor = res.cursor;
      }
      return null;
    } catch (e) {
      this.logger.warn(
        `листинг ${prefix} не удался: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  // ── Крон хранения (В-3) ───────────────────────────────────────────────

  /**
   * 1) Проверенные персоны — селфи и ролик через 30 дней после создания
   *    последнего образа (без образов — после проверки); ставится
   *    `sourcesPurgedAt`, дальше источник новых образов — базовый образ.
   * 2) Незавершённые попытки старше суток — лицо без цели хранения;
   *    пути обнуляются, пересъёмка — новый `POST /personas`.
   * 3) Отозванные персоны: недоудалённые при DELETE — дочистить целиком;
   *    надгробия 18 с оставшимися путями — удалить файлы.
   * 4) Список ожидания удаления клонов у Resemble — повтор.
   *
   * Путь обнуляется только после того, как хранилище приняло удаление.
   * Выборки — по `id` с курсором (CONTRACT5, п.16): упавшая строка не
   * возвращается в ту же выборку и не занимает место всех остальных.
   */
  async purgeExpiredSources(
    now: Date = new Date(),
  ): Promise<PersonaRetentionResult> {
    const out: PersonaRetentionResult = {
      purged: 0,
      abandoned: 0,
      erased: 0,
      failed: 0,
    };
    const select = {
      id: true,
      userId: true,
      selfiePathname: true,
      livenessPathname: true,
      revokedAt: true,
      verifyResult: true,
    } as const;
    type Row = {
      id: string;
      userId: string;
      selfiePathname: string | null;
      livenessPathname: string | null;
      revokedAt: Date | null;
      verifyResult: unknown;
    };

    const cutoff = personaSourcesCutoff(now);
    await this.eachById<Row>(
      {
        revokedAt: null,
        livenessCheckedAt: { not: null, lt: cutoff },
        sourcesPurgedAt: null,
        // «Последний образ» раньше границы — ни одного образа новее неё.
        looks: { none: { createdAt: { gte: cutoff } } },
      },
      select,
      async (p) => {
        if (!(await this.deleteSourceFiles(p))) return void out.failed++;
        await this.prisma.persona.update({
          where: { id: p.id },
          data: {
            selfiePathname: null,
            livenessPathname: null,
            sourcesPurgedAt: now,
          },
        });
        out.purged++;
      },
    );

    await this.eachById<Row>(
      {
        revokedAt: null,
        livenessCheckedAt: null,
        consentGivenAt: { lt: personaAbandonedCutoff(now) },
        OR: [
          { selfiePathname: { not: null } },
          { livenessPathname: { not: null } },
        ],
      },
      select,
      async (p) => {
        if (!(await this.deleteSourceFiles(p))) return void out.failed++;
        await this.prisma.persona.update({
          where: { id: p.id },
          data: { selfiePathname: null, livenessPathname: null },
        });
        out.abandoned++;
      },
    );

    await this.eachById<Row>(
      {
        revokedAt: { not: null },
        // Дочищенные надгробия 18 живут вечно — без этого исключения их
        // растущее число заняло бы все выборки прохода, и недоудалённые
        // персоны до крона не доходили бы (аудит проверки). «Дочищено» —
        // признак `cleanTombstone`: не проверена, источников нет,
        // `sourcesPurgedAt` стоит. У отозванной НЕ-надгробной строки такого
        // сочетания не бывает: `sourcesPurgedAt` ставит только крон В-3,
        // а он берёт лишь проверенные персоны.
        NOT: {
          livenessCheckedAt: null,
          sourcesPurgedAt: { not: null },
          selfiePathname: null,
          livenessPathname: null,
        },
      },
      select,
      async (p) => {
        if (isUnder18Tombstone(p)) {
          if (await this.cleanTombstone(p, now)) out.erased++;
          else out.failed++;
          return;
        }
        const full = await this.prisma.persona.findUnique({
          where: { id: p.id },
        });
        if (!full) return;
        if (await this.erase(full)) out.erased++;
        else out.failed++;
      },
    );

    const resemble = this.optionalClass(ResembleService);
    if (resemble) {
      try {
        out.resembleRetried = (await resemble.retryPendingDeletes()).retried;
      } catch (e) {
        this.logger.warn(
          `повтор удалений Resemble не удался: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    if (out.failed > 0) {
      this.logger.warn(
        `persona-sources-purge: у ${out.failed} персон хранилище не приняло удаление — повтор на следующем прогоне`,
      );
    }
    return out;
  }

  /**
   * Обход строк по `id` с курсором: каждая строка — не больше одного раза
   * за прогон, упавшая не блокирует следующие. Потолок — выборок за прогон.
   */
  private async eachById<T extends { id: string }>(
    where: Prisma.PersonaWhereInput,
    select: Prisma.PersonaSelect,
    handle: (row: T) => Promise<void>,
  ): Promise<void> {
    let cursor: string | null = null;
    for (let batch = 0; batch < PERSONA_RETENTION_MAX_BATCHES; batch++) {
      const rows = (await this.prisma.persona.findMany({
        where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
        select,
        orderBy: { id: 'asc' },
        take: PERSONA_RETENTION_BATCH,
      })) as unknown as T[];
      for (const row of rows) {
        try {
          await handle(row);
        } catch (e) {
          this.logger.warn(
            `persona-sources-purge: персона ${row.id} пропущена: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (rows.length < PERSONA_RETENTION_BATCH) return;
      cursor = rows[rows.length - 1].id;
    }
  }

  private async deleteSourceFiles(p: {
    selfiePathname: string | null;
    livenessPathname: string | null;
  }): Promise<boolean> {
    const paths = [p.selfiePathname, p.livenessPathname].filter(
      (x): x is string => !!x,
    );
    if (paths.length === 0) return true;
    return (await this.blob.deleteMany(paths)) === paths.length;
  }

  /**
   * Файлы надгробия 18 — удалить и пометить дочищенным (`sourcesPurgedAt`),
   * чтобы крон больше его не выбирал. `false` — хранилище приняло не всё.
   */
  private async cleanTombstone(
    p: {
      id: string;
      selfiePathname: string | null;
      livenessPathname: string | null;
    },
    now: Date,
  ): Promise<boolean> {
    if (!(await this.deleteSourceFiles(p))) return false;
    await this.prisma.persona.update({
      where: { id: p.id },
      data: {
        selfiePathname: null,
        livenessPathname: null,
        sourcesPurgedAt: now,
      },
    });
    return true;
  }

  /** Удалить загруженные источники попытки (отказ, пересъёмка). */
  private async dropSources(persona: Persona): Promise<void> {
    if (await this.deleteSourceFiles(persona)) {
      await this.prisma.persona.update({
        where: { id: persona.id },
        data: { selfiePathname: null, livenessPathname: null },
      });
    }
  }
}

const BASE_GENERATIONS_EXHAUSTED =
  'Базовый образ сегодня уже создавался много раз — пересоздайте его завтра';

function deleteIncomplete(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'PERSONA_DELETE_INCOMPLETE',
    message:
      'Не все файлы удалось удалить прямо сейчас. Режим уже отключён, остальное удалится автоматически в течение суток.',
  });
}

function under18Answer(p: Persona): VerifyPersonaResult {
  return {
    status: 'refused',
    reasons: ['under-18'],
    ...(p.ageMin !== null && p.ageMax !== null
      ? { ageMin: p.ageMin, ageMax: p.ageMax }
      : {}),
  };
}

function personaToView(p: Persona): PersonaView {
  return {
    id: p.id,
    consentGivenAt: p.consentGivenAt.toISOString(),
    verified: p.livenessCheckedAt !== null,
    ageMin: p.ageMin,
    ageMax: p.ageMax,
    sourcesPurgedAt: p.sourcesPurgedAt?.toISOString() ?? null,
    refusals: refusalsOf(p.verifyResult),
  };
}

/** Итог проверки для `verifyResult` — без возраста (он в своих колонках). */
function storedResult(
  r: FaceCheckResult | null,
  reasons: string[],
  now: Date,
): StoredVerifyResult {
  return {
    status: reasons.length ? 'refused' : 'ok',
    reasons,
    refusals: reasons,
    checkedAt: now.toISOString(),
    ...(r
      ? {
          faces: r.faces,
          frontal: r.frontal,
          quality: r.quality,
          screenOrPrint: r.screenOrPrint,
          sameAsSelfie: r.sameAsSelfie,
          liveMotion: r.liveMotion,
        }
      : {}),
  };
}
