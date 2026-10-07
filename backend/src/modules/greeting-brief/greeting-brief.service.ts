/**
 * GreetingBriefService — GET/PATCH /projects/:id/greeting-brief (ТЗ
 * TZ-Greeting-Video-Project-Type.md §8).
 *
 * Creation lives in `ProjectService.createGreetingVideoProject` (§4.1,
 * §4.3): a GreetingBrief is always created together with its Project, in
 * one transaction, so there's never a GREETING_VIDEO project without one
 * — this service only ever edits/reads a brief that already exists.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  PERSONA_DISABLED_CODE,
  PERSONA_DISABLED_MESSAGE,
  PresenterLookRow,
  personaEnabled,
  presenterLookProblem,
  presenterProviderProblem,
  presenterSnapshotFrom,
} from '../../common/greeting-persona';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { resolveGreetingConfig } from '../project/greeting-config';
import { UpdateGreetingBriefDto } from '../project/dto/update-greeting-brief.dto';
import { GREETING_OCCASION_SPECS } from '../../common/greeting-occasions';
import {
  OTHER_MOOD_REQUIRED,
  otherMoodMissing,
  resolveBriefRegister,
  storedUserRegister,
  toneAllowedForRegister,
  toneRefusal,
} from '../../common/greeting-policy';
import {
  GreetingBriefView,
  GreetingOccasion,
  GreetingPresenterChoice,
  GreetingPresenterProvider,
  GreetingPresenterSnapshot,
  GreetingPresenterVariant,
  GreetingRegister,
  GreetingRegisterSource,
  GreetingResolution,
  GreetingTone,
} from '../../common/types/greeting.types';
import { GreetingRegisterClassifier } from './greeting-register-classifier.service';
import { SupportedLocale, isSupportedLocale } from '../../common/locale';
import {
  GREETING_ERROR_CODES,
  greetingError,
} from '../../common/greeting-errors';

interface GreetingBriefRow {
  id: string;
  projectId: string;
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  occasionRegister?: GreetingRegister | null;
  registerSource?: string | null;
  userOccasionRegister?: GreetingRegister | null;
  scriptLanguage?: string | null;
  recipientName: string;
  senderName: string | null;
  tone: GreetingTone;
  personalMessage: string | null;
  presenterProvider: string;
  resolution: string;
  brandManifestId: string | null;
  occasionDate: Date | null;
  presenterLookId?: string | null;
  presenterVariant?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** База правки: строка брифа или снимок сессии, приведённый к ней. */
export interface BriefBase {
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  occasionRegister?: GreetingRegister | null;
  registerSource?: string | null;
  userOccasionRegister?: GreetingRegister | null;
  scriptLanguage?: string | null;
  recipientName: string;
  senderName: string | null;
  tone: GreetingTone;
  personalMessage: string | null;
  presenterProvider: string;
  resolution: string;
  occasionDate: Date | null;
  /** Этап G: ведущий-образ; нет полей — ИИ-ведущий. */
  presenterLookId?: string | null;
  presenterVariant?: string | null;
}

/** Проверенный итог правки — полный набор редактируемых полей. */
export interface ResolvedBriefFields {
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  occasionRegister: GreetingRegister | null;
  registerSource: GreetingRegisterSource | null;
  /** Ответ человека о настроении; у каталожных поводов — `null`. */
  userOccasionRegister: GreetingRegister | null;
  scriptLanguage: SupportedLocale | null;
  recipientName: string;
  senderName: string | null;
  tone: GreetingTone;
  personalMessage: string | null;
  presenterProvider: GreetingPresenterProvider;
  resolution: GreetingResolution;
  occasionDate: Date | null;
  /** Этап G (§4.8): образ персоны автора или `null` — ИИ-ведущий. */
  presenterLookId: string | null;
  presenterVariant: GreetingPresenterVariant | null;
}

/** Образ со всем, что нужно проверке и снимку (`PresenterLookRow`). */
export const PRESENTER_LOOK_INCLUDE = {
  activeSketch: { select: { url: true, pathname: true, status: true } },
  persona: { select: { userId: true, revokedAt: true } },
} as const;

export interface PresenterColumns {
  presenterLookId: string | null;
  presenterVariant: GreetingPresenterVariant | null;
}

/** Минимум Prisma, нужный чтению образа (структурно — ради тестов). */
export interface PresenterLookReader {
  personaLook: {
    findFirst(args: {
      where: Record<string, unknown>;
      include: typeof PRESENTER_LOOK_INCLUDE;
    }): Promise<unknown>;
  };
}

/**
 * Образ персоны автора. Режим выключен — 404 с кодом `PERSONA_DISABLED`,
 * тем же, что у маршрутов персоны: фронтенд прячет выбор по этому коду.
 */
export async function loadPresenterLook(
  prisma: PresenterLookReader,
  userId: string,
  lookId: string,
): Promise<PresenterLookRow | null> {
  if (!personaEnabled()) {
    throw new NotFoundException({
      code: PERSONA_DISABLED_CODE,
      message: PERSONA_DISABLED_MESSAGE,
    });
  }
  return (await prisma.personaLook.findFirst({
    where: { id: lookId, persona: { userId } },
    include: PRESENTER_LOOK_INCLUDE,
  })) as PresenterLookRow | null;
}

/**
 * Выбор ведущего из DTO → колонки брифа. `ai` — сброс (поля образа, если
 * их прислали, игнорируются). Образ персоны — только при включённом
 * режиме и только свой: чужой id читается как «не найден». Один код на
 * создание проекта и на правку брифа.
 */
export async function resolvePresenterChoice(
  prisma: PresenterLookReader,
  userId: string,
  choice: GreetingPresenterChoice,
): Promise<PresenterColumns> {
  if (choice.kind !== 'persona') {
    return { presenterLookId: null, presenterVariant: null };
  }
  const look = await loadPresenterLook(prisma, userId, choice.lookId);
  const problem = presenterLookProblem(look, choice.variant, userId);
  if (problem) throw new BadRequestException(problem);
  return { presenterLookId: choice.lookId, presenterVariant: choice.variant };
}

@Injectable()
export class GreetingBriefService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    /**
     * Этап B: третий сигнал регистра «Особого повода». Необязательный —
     * без него (юнит-тесты, стенд без ключа Gemini) остаются выбор
     * человека и ключевые слова, и результат всё равно безопасный.
     */
    @Optional()
    private readonly registerClassifier?: GreetingRegisterClassifier,
  ) {}

  async getBrief(
    userId: string,
    projectId: string,
  ): Promise<GreetingBriefView> {
    const row = await this.findOwnBrief(userId, projectId);
    return toGreetingBriefView(row);
  }

  /**
   * §8: правка текста/повода/тона до запуска генерации. Нет замка по
   * статусу сессии — сам бриф не знает, начата ли уже генерация (это
   * знает Session, которая копирует бриф СНИМКОМ при создании, §4.3):
   * правка брифа ПОСЛЕ того, как из него уже сделана сессия, просто не
   * затрагивает эту сессию, как и правка ProductItem не затрагивает уже
   * созданные из него Session сегодня.
   */
  async updateBrief(
    userId: string,
    projectId: string,
    dto: UpdateGreetingBriefDto,
  ): Promise<GreetingBriefView> {
    const current = await this.findOwnBrief(userId, projectId);
    const next = await this.resolveNext(userId, current, dto);
    const row: GreetingBriefRow = await this.prisma.greetingBrief.update({
      where: { id: current.id },
      data: {
        ...next,
        ...(dto.brandManifestId !== undefined
          ? { brandManifestId: dto.brandManifestId }
          : {}),
      },
    });
    return toGreetingBriefView(row);
  }

  /**
   * Этап C (§3.6): правка из сессии пишет итог и в бриф проекта — следующая
   * сессия этого проекта начнётся уже с исправленного, а не с того, что
   * было до правки. `next` уже проверен `resolveNext`.
   */
  async writeResolved(
    userId: string,
    projectId: string,
    next: ResolvedBriefFields,
  ): Promise<void> {
    const current = await this.findOwnBrief(userId, projectId);
    // Этап G: ведущий из снимка сессии может ссылаться на образ, которого
    // уже нет (персону удалили, строки образов ушли каскадом). Внешний
    // ключ такую запись отверг бы 500-й; бриф проекта для следующей
    // сессии честно становится «ИИ-ведущий».
    const lookGone =
      !!next.presenterLookId &&
      !(await this.prisma.personaLook.findFirst({
        where: { id: next.presenterLookId },
        select: { id: true },
      }));
    await this.prisma.greetingBrief.update({
      where: { id: current.id },
      data: {
        ...next,
        ...(lookGone ? { presenterLookId: null, presenterVariant: null } : {}),
      },
    });
  }

  /**
   * Вся проверка правки брифа — одна на оба пути: `PATCH
   * /projects/:id/greeting-brief` (база — строка брифа) и `PATCH
   * /sessions/:id/greeting-brief` (база — снимок сессии, этап C). Две
   * копии проверки однажды разошлись бы, и путь, который забыли
   * обновить, пропустил бы шутливое соболезнование.
   *
   * Возвращает ПОЛНЫЙ набор полей, а не только изменённые: сессия
   * собирает из него снимок, проект — строку.
   */
  async resolveNext(
    userId: string,
    current: BriefBase,
    dto: UpdateGreetingBriefDto,
  ): Promise<ResolvedBriefFields> {
    const occasion = dto.occasion ?? current.occasion;
    const customOccasionText =
      dto.customOccasionText !== undefined
        ? dto.customOccasionText?.trim() || null
        : current.customOccasionText;
    if (occasion === 'OTHER' && !customOccasionText) {
      throw new BadRequestException(
        greetingError(
          GREETING_ERROR_CODES.GREETING_OCCASION_TEXT_REQUIRED,
          'Для повода «Другое» напишите, что за повод.',
        ),
      );
    }

    /**
     * Этап 2, фича №3 компаньон-ТЗ: тон проверяется на СЕРВЕРЕ, а не
     * прячется в интерфейсе. §3 ТЗ требует именно этого — и не зря:
     * визард можно обойти прямым запросом к API, а шутливое
     * соболезнование обойти нечем.
     *
     * Проверяется ПАРА (повод, тон), а не каждое поле по отдельности,
     * потому что сломать её можно с двух сторон: поставить FUNNY при
     * уже выбранном CONDOLENCE — и сменить повод на CONDOLENCE, когда
     * FUNNY стоял там с прошлой правки. Второй путь незаметнее, и без
     * этой проверки он молча прошёл бы.
     *
     * Отказ, а не тихая подмена тона на допустимый, — принцип 4 раздела
     * 3 компаньон-ТЗ, тот же, по которому `resolveGreetingConfig`
     * отвечает 403 вместо подмены hedra на grok.
     */
    /**
     * Этап B (ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md
     * §3.4): у «Особого повода» набор тонов зависит от регистра, а регистр
     * — от выбора человека, ключевых слов и классификатора, и итог — самый
     * строгий из них.
     *
     * Прошлый ответ классификатора, который ТОГДА ПОБЕДИЛ
     * (`registerSource === 'classifier'`), переиспользуется прямо из
     * брифа, если описание повода с тех пор не менялось. Во всех
     * остальных случаях (обычный: классификатор согласился с базовым
     * регистром и потому в брифе не записан) зовётся `classify`, а он
     * сначала смотрит в свою память ответов по хешу описания (заход 8,
     * C14) и модель спрашивает, только если на это описание она ещё не
     * отвечала. Сбой модели не запоминается — один сбой Gemini не
     * выключает третий сигнал для брифа.
     */
    const textChanged =
      occasion !== current.occasion ||
      customOccasionText !== current.customOccasionText;
    const currentSource = (current.registerSource ??
      null) as GreetingRegisterSource | null;
    // Ответ человека — из запроса, а без него сохранённый: он лежит
    // отдельно от итога, так что подъём регистра словами или
    // классификатором его не стирает, и правка опечатки в имени не
    // требует отвечать заново. Переписал человек описание так, что
    // подъём снят, — итог вернётся к этому ответу, а не к умолчанию.
    const userRegister =
      dto.occasionRegister !== undefined
        ? dto.occasionRegister
        : storedUserRegister(current);
    // Этап D (§3.4 п.1, приёмка §8.1): у OTHER ответ о настроении
    // обязателен и при правке. Старый бриф OTHER без ответа (источник
    // 'default' или поднятый словами/классификатором ДО отдельной колонки
    // ответа) не сохранится, пока человек не ответит, — так и задумано:
    // интерфейс задаёт вопрос и без ответа дальше не пускает. Явный
    // `null` — тот же пропуск.
    // Проверка — до классификатора, чтобы отказ не стоил вызова модели.
    if (otherMoodMissing(occasion, userRegister)) {
      throw new BadRequestException(OTHER_MOOD_REQUIRED);
    }
    const reg = await resolveBriefRegister(
      {
        occasion,
        customOccasionText,
        userRegister,
        knownClassifier:
          !textChanged && currentSource === 'classifier'
            ? (current.occasionRegister ?? null)
            : null,
      },
      this.registerClassifier
        ? (text) => this.registerClassifier!.classify(text, userId)
        : undefined,
    );
    const register =
      reg.occasionRegister ?? GREETING_OCCASION_SPECS[occasion].register;

    const tone = dto.tone ?? current.tone;
    if (!toneAllowedForRegister(occasion, register, tone)) {
      throw new BadRequestException(
        toneRefusal(occasion, register, tone, reg.keyword),
      );
    }

    if (dto.brandManifestId) {
      await this.assertOwnBrandManifest(userId, dto.brandManifestId);
    }

    // §7: провайдер/разрешение — то же самое гейтирование, что при
    // создании (см. `resolveGreetingConfig`'s doc-comment) — правка снимка
    // конфигурации тоже активный выбор, не только его первичное задание.
    let presenterProvider: GreetingPresenterProvider =
      current.presenterProvider as GreetingPresenterProvider;
    let resolution: GreetingResolution =
      current.resolution as GreetingResolution;
    if (dto.presenterProvider !== undefined || dto.resolution !== undefined) {
      const plan = await this.plans.planOfUser(userId);
      const resolved = resolveGreetingConfig(plan, {
        presenterProvider: dto.presenterProvider ?? presenterProvider,
        resolution: dto.resolution ?? resolution,
      });
      presenterProvider = resolved.presenterProvider;
      resolution = resolved.resolution;
    }

    // Этап G (§4.8): «кто в кадре». Не передан — прежний выбор. Выбор
    // образа проверяется здесь, на обоих путях правки: образ свой, не
    // удалён, готов; скетч — только если скетч у образа есть. Сочетание
    // со скетчем на Hedra проверяется и тогда, когда поменяли только
    // провайдера: иначе смена grok → hedra протащила бы непроверенный
    // рисованный портрет.
    let presenterLookId = current.presenterLookId ?? null;
    let presenterVariant = (current.presenterVariant ??
      null) as GreetingPresenterVariant | null;
    if (dto.presenter !== undefined) {
      const choice = await this.resolvePresenterChoice(userId, dto.presenter);
      presenterLookId = choice.presenterLookId;
      presenterVariant = choice.presenterVariant;
    }
    const providerProblem = presenterLookId
      ? presenterProviderProblem(presenterProvider, presenterVariant)
      : null;
    if (providerProblem) throw new BadRequestException(providerProblem);

    return {
      occasion,
      customOccasionText,
      occasionRegister: reg.occasionRegister,
      registerSource: reg.registerSource,
      // Только у OTHER: у каталожных поводов вопрос не задаётся, и
      // прежний ответ при смене повода с «Особого» забывается.
      userOccasionRegister:
        occasion === 'OTHER' ? (userRegister ?? null) : null,
      scriptLanguage:
        dto.scriptLanguage !== undefined
          ? dto.scriptLanguage
          : isSupportedLocale(current.scriptLanguage)
            ? current.scriptLanguage
            : null,
      recipientName:
        dto.recipientName !== undefined
          ? dto.recipientName.trim()
          : current.recipientName,
      senderName:
        dto.senderName !== undefined
          ? dto.senderName?.trim() || null
          : current.senderName,
      // `tone`, а не `dto.tone`: в базу уходит ровно то значение,
      // которое прошло проверку пары выше.
      tone,
      personalMessage:
        dto.personalMessage !== undefined
          ? dto.personalMessage?.trim() || null
          : current.personalMessage,
      presenterProvider,
      resolution,
      occasionDate:
        dto.occasionDate !== undefined
          ? dto.occasionDate
            ? new Date(dto.occasionDate)
            : null
          : current.occasionDate,
      presenterLookId,
      presenterVariant: presenterLookId ? presenterVariant : null,
    };
  }

  /** См. модульную `resolvePresenterChoice` выше — метод ради DI. */
  resolvePresenterChoice(
    userId: string,
    choice: GreetingPresenterChoice,
  ): Promise<PresenterColumns> {
    return resolvePresenterChoice(this.prisma, userId, choice);
  }

  /**
   * Копия образа для снимка сессии (правка из сессии, этап C + G). Та же
   * проверка, что при выборе: образ, удалённый между выбором и стартом,
   * не должен молча превратиться в ИИ-ведущего или в битую ссылку.
   */
  async presenterSnapshot(
    userId: string,
    lookId: string,
    variant: GreetingPresenterVariant,
  ): Promise<GreetingPresenterSnapshot> {
    const look = await loadPresenterLook(this.prisma, userId, lookId);
    const problem = presenterLookProblem(look, variant, userId);
    if (problem || !look) throw new BadRequestException(problem);
    return presenterSnapshotFrom(look, variant);
  }

  private async findOwnBrief(
    userId: string,
    projectId: string,
  ): Promise<GreetingBriefRow> {
    // Ownership through the parent project (same pattern as
    // ProjectService.findOwnItem) — `deletedAt: null` on the project so a
    // soft-deleted project's brief reads as 404 during the grace period,
    // like everything else under it.
    const row: GreetingBriefRow | null =
      await this.prisma.greetingBrief.findFirst({
        where: { projectId, project: { userId, deletedAt: null } },
      });
    if (!row) {
      // Без идентификатора в тексте: его читает человек (CONTRACT6 п.7).
      throw new NotFoundException(
        greetingError(
          GREETING_ERROR_CODES.GREETING_BRIEF_NOT_FOUND,
          'Бриф поздравления не найден — возможно, проект удалён.',
        ),
      );
    }
    return row;
  }

  private async assertOwnBrandManifest(
    userId: string,
    brandManifestId: string,
  ): Promise<void> {
    const manifest = await this.prisma.brandManifest.findFirst({
      where: { id: brandManifestId, userId },
      select: { id: true },
    });
    if (!manifest) {
      throw new BadRequestException(
        greetingError(
          GREETING_ERROR_CODES.GREETING_BRAND_NOT_FOUND,
          'Выбранный бренд-бук не найден — выберите другой или уберите его.',
        ),
      );
    }
  }
}

export function toGreetingBriefView(row: GreetingBriefRow): GreetingBriefView {
  return {
    id: row.id,
    projectId: row.projectId,
    occasion: row.occasion,
    customOccasionText: row.customOccasionText,
    occasionRegister: row.occasionRegister ?? null,
    registerSource:
      (row.registerSource as GreetingRegisterSource | null | undefined) ?? null,
    // Строка до этой колонки — тот же разбор, что и при правке.
    userOccasionRegister: storedUserRegister(row),
    scriptLanguage: isSupportedLocale(row.scriptLanguage)
      ? row.scriptLanguage
      : null,
    recipientName: row.recipientName,
    senderName: row.senderName,
    tone: row.tone,
    personalMessage: row.personalMessage,
    presenterProvider: row.presenterProvider as GreetingPresenterProvider,
    resolution: row.resolution as GreetingResolution,
    brandManifestId: row.brandManifestId,
    occasionDate: row.occasionDate ? row.occasionDate.toISOString() : null,
    presenter: presenterChoiceOf(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Колонки брифа → выбор «кто в кадре» для экрана. */
export function presenterChoiceOf(row: {
  presenterLookId?: string | null;
  presenterVariant?: string | null;
}): GreetingPresenterChoice {
  return row.presenterLookId
    ? {
        kind: 'persona',
        lookId: row.presenterLookId,
        variant: row.presenterVariant === 'sketch' ? 'sketch' : 'photo',
      }
    : { kind: 'ai' };
}
