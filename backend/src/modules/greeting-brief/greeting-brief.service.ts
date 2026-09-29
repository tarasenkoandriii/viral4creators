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
  GreetingPresenterProvider,
  GreetingRegister,
  GreetingRegisterSource,
  GreetingResolution,
  GreetingTone,
} from '../../common/types/greeting.types';
import { GreetingRegisterClassifier } from './greeting-register-classifier.service';
import { SupportedLocale, isSupportedLocale } from '../../common/locale';

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
    await this.prisma.greetingBrief.update({
      where: { id: current.id },
      data: { ...next },
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
        'customOccasionText is required when occasion is OTHER',
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
     * Прошлый ответ классификатора переиспользуется, только если он
     * ТОГДА ПОБЕДИЛ (`registerSource === 'classifier'`) и описание повода
     * с тех пор не менялось. Во всех остальных случаях — а это обычный
     * случай: классификатор согласился с базовым регистром и потому не
     * записан — он зовётся заново, и повторное сохранение брифа стоит
     * ещё одного короткого вызова модели.
     *
     * Так и задумано. Отличить «классификатор ответил, но не поднял
     * регистр» от «классификатор не ответил вовсе» негде: из сигналов
     * машины хранится только победивший (ответ человека — отдельно, в
     * `userOccasionRegister`). Если считать оба за «уже
     * спрашивали», один сбой Gemini навсегда выключил бы третий сигнал
     * для этого брифа — ошибка в сторону праздника, ровно та, ради
     * которой этап B и написан. Лишний вызов дешевле.
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
    };
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
      throw new NotFoundException(
        `Greeting brief not found for project ${projectId}`,
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
        `Brand manifest ${brandManifestId} not found`,
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
