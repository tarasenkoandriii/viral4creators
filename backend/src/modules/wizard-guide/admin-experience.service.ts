/**
 * Модерация корпуса опыта — «Тонкая красная линия» §6.5, §10, этап 9.
 *
 * Отдельный сервис от `ExperienceService` намеренно: там — то, что
 * видит пользователь, здесь — то, что делает оператор. Один класс на
 * обе роли рано или поздно отдаёт одно вместо другого, а цена такой
 * ошибки здесь — непроверенный текст в подсказке.
 *
 * ## Что автоматика имеет право решать
 *
 * Ничего из того, что здесь написано. Публикация — только человеком
 * (§6.5): пользовательский ввод в нашем промпте, «частая ошибка ≠
 * полезный совет» и несимметричная цена ошибки. Сведение дублей (этап
 * 10) — единственное, что делегируется модели, и оно говорит «это та же
 * проблема», а не «вот что человеку делать».
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../../common/locale';
import { isKnownUiKey, uiKeysOf } from './ui-keys';
import { canPublish, PUBLISH_DENIED, type ExperienceText } from './experience';

export interface TextInput {
  symptom: string;
  cause?: string | null;
  advice: string;
}

export interface ExperienceView {
  id: string;
  scenario: string;
  stepId: string;
  status: string;
  occurrences: number;
  createdAt: Date;
  updatedAt: Date;
  texts: Array<ExperienceText & { id: string; updatedAt: Date }>;
  /** Ключи словаря, которых больше нет, — правит оператор (§6.7). */
  brokenKeys: string[];
  /** Публикация возможна: есть русский совет, прочитанный человеком. */
  publishable: boolean;
}

@Injectable()
export class AdminExperienceService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Ситуации ─────────────────────────────────────────────────────

  async list(filter: {
    scenario?: string;
    stepId?: string;
    status?: string;
    /** Локаль с непрочитанными переводами (§10, этап 11). */
    unreviewedLocale?: string;
  }): Promise<ExperienceView[]> {
    const rows = await this.prisma.wizardExperience.findMany({
      where: {
        ...(filter.scenario ? { scenario: filter.scenario } : {}),
        ...(filter.stepId ? { stepId: filter.stepId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.unreviewedLocale
          ? {
              texts: {
                some: { locale: filter.unreviewedLocale, reviewed: false },
              },
            }
          : {}),
      },
      orderBy: [{ occurrences: 'desc' }, { updatedAt: 'desc' }],
      take: 200,
      include: { texts: true },
    });
    return (rows as unknown as ExperienceView[]).map((r) => this.view(r));
  }

  private view(row: ExperienceView): ExperienceView {
    const brokenKeys: string[] = [];
    for (const t of row.texts) {
      for (const key of uiKeysOf(
        [t.symptom, t.cause ?? '', t.advice].join('\n'),
      )) {
        if (!isKnownUiKey(key) && !brokenKeys.includes(key))
          brokenKeys.push(key);
      }
    }
    return { ...row, brokenKeys, publishable: canPublish(row.texts) };
  }

  /**
   * Правка текста на языке.
   *
   * Правка оператором ВСЕГДА означает `reviewed: true` и `ADMIN`: он
   * только что его прочитал, и держать после этого пометку «не
   * прочитано» — врать очереди непрочитанных переводов. Перевод модели
   * приходит другим путём (`saveTranslation`, этап 11).
   */
  async saveText(
    experienceId: string,
    locale: string,
    input: TextInput,
  ): Promise<ExperienceView> {
    this.assertLocale(locale);
    this.assertText(input);
    // Существование ситуации проверяем сами: иначе нарушение внешнего
    // ключа доедет до оператора пятисоткой без единого слова о том, что
    // произошло.
    await this.one(experienceId);
    await this.prisma.wizardExperienceText.upsert({
      where: { experienceId_locale: { experienceId, locale } },
      create: {
        experienceId,
        locale,
        symptom: input.symptom.trim(),
        cause: input.cause?.trim() || null,
        advice: input.advice.trim(),
        source: 'ADMIN',
        reviewed: true,
      },
      update: {
        symptom: input.symptom.trim(),
        cause: input.cause?.trim() || null,
        advice: input.advice.trim(),
        source: 'ADMIN',
        reviewed: true,
      },
    });
    return this.one(experienceId);
  }

  /** Пометить перевод прочитанным, ничего в нём не меняя. */
  async markReviewed(
    experienceId: string,
    locale: string,
  ): Promise<ExperienceView> {
    const updated = await this.prisma.wizardExperienceText
      .update({
        where: { experienceId_locale: { experienceId, locale } },
        data: { reviewed: true },
      })
      .catch(() => null);
    if (!updated)
      throw new NotFoundException(
        `У ситуации ${experienceId} нет текста на «${locale}»`,
      );
    return this.one(experienceId);
  }

  /**
   * Публикация — единственное место, где запись становится видимой
   * людям. Условие ровно одно и оно же вся модерация §6.5.
   */
  async publish(id: string, operatorId: string): Promise<ExperienceView> {
    const row = await this.one(id);
    if (!canPublish(row.texts)) throw new BadRequestException(PUBLISH_DENIED);
    await this.prisma.wizardExperience.update({
      where: { id },
      data: { status: 'PUBLISHED', publishedBy: operatorId },
    });
    return this.one(id);
  }

  async setStatus(id: string, status: string): Promise<ExperienceView> {
    if (status === 'PUBLISHED')
      throw new BadRequestException(
        'Публикация идёт отдельным действием — оно проверяет русский совет.',
      );
    await this.prisma.wizardExperience.update({
      where: { id },
      data: { status },
    });
    return this.one(id);
  }

  async one(id: string): Promise<ExperienceView> {
    const row = await this.prisma.wizardExperience.findUnique({
      where: { id },
      include: { texts: true },
    });
    if (!row) throw new NotFoundException(`Ситуация ${id} не найдена`);
    return this.view(row as unknown as ExperienceView);
  }

  // ── Кандидаты ────────────────────────────────────────────────────

  async candidates(filter: {
    status?: string;
    scenario?: string;
    stepId?: string;
    decision?: string;
  }) {
    return this.prisma.wizardExperienceCandidate.findMany({
      where: {
        status: filter.status ?? 'NEW',
        ...(filter.scenario ? { scenario: filter.scenario } : {}),
        ...(filter.stepId ? { stepId: filter.stepId } : {}),
        ...(filter.decision ? { decision: filter.decision } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        matched: { include: { texts: true } },
      },
    });
  }

  /**
   * Завести новую ситуацию из кандидата.
   *
   * Русский совет пишется СРАЗУ и здесь же: ситуация без него всё равно
   * не публикуется, а заводить пустую заготовку значит копить в базе
   * то, что потом никто не опознает.
   *
   * Сырой текст кандидата в ситуацию не переносится ни в каком виде —
   * оператор пишет своими словами. Это и есть граница §6.5.
   */
  async promote(
    candidateId: string,
    input: TextInput,
    operatorId: string,
  ): Promise<ExperienceView> {
    this.assertText(input);
    const candidate = await this.candidate(candidateId, 'NEW');
    const created = await this.prisma.wizardExperience.create({
      data: {
        scenario: candidate.scenario,
        stepId: candidate.stepId,
        status: 'DRAFT',
        createdBy: operatorId,
        texts: {
          create: {
            locale: DEFAULT_LOCALE,
            symptom: input.symptom.trim(),
            cause: input.cause?.trim() || null,
            advice: input.advice.trim(),
            source: 'ADMIN',
            reviewed: true,
          },
        },
      },
      select: { id: true },
    });
    await this.prisma.wizardExperienceCandidate.update({
      where: { id: candidateId },
      data: {
        status: 'PROMOTED',
        matchedId: created.id,
        decision: candidate.decision ?? 'NONE',
        decidedBy: operatorId,
      },
    });
    return this.one(created.id);
  }

  /**
   * Свести кандидата с существующей ситуацией.
   *
   * `occurrences` растёт — по нему сортируется срез корпуса (§5.6):
   * ситуация, встретившаяся десять раз, важнее для промпта, чем
   * встретившаяся однажды.
   */
  async merge(
    candidateId: string,
    experienceId: string,
    operatorId: string,
  ): Promise<{ ok: true }> {
    await this.candidate(candidateId, 'NEW');
    await this.one(experienceId);
    await this.prisma.$transaction([
      this.prisma.wizardExperienceCandidate.update({
        where: { id: candidateId },
        data: {
          status: 'MERGED',
          matchedId: experienceId,
          decision: 'OPERATOR',
          decidedBy: operatorId,
        },
      }),
      this.prisma.wizardExperience.update({
        where: { id: experienceId },
        data: { occurrences: { increment: 1 } },
      }),
    ]);
    return { ok: true };
  }

  /**
   * «Это другое» — вернуть кандидата в очередь и откатить счётчик.
   *
   * Единственная страховка от того, что новая проблема утонет как
   * мнимый дубль (§6.4). Счётчик обязан откатиться: иначе он врёт
   * навсегда, а по нему сортируется промпт.
   *
   * `matchScore` при этом СОХРАНЯЕТСЯ — по нему потом двигают порог, и
   * отвергнутое решение для этого ценнее принятого.
   */
  async unmerge(
    candidateId: string,
    operatorId: string,
  ): Promise<{ ok: true }> {
    const candidate = await this.candidate(candidateId, 'MERGED');
    const ops = [
      this.prisma.wizardExperienceCandidate.update({
        where: { id: candidateId },
        data: {
          status: 'NEW',
          matchedId: null,
          decision: 'NONE',
          decidedBy: operatorId,
        },
      }),
    ];
    if (candidate.matchedId) {
      ops.push(
        this.prisma.wizardExperience.update({
          where: { id: candidate.matchedId },
          data: { occurrences: { decrement: 1 } },
        }),
      );
    }
    await this.prisma.$transaction(ops);
    return { ok: true };
  }

  /**
   * Прикрепить кандидата к существующей ситуации КАК ТЕКСТ на его
   * языке (прямая просьба владельца, §6.7).
   *
   * Без этого действия одна и та же грабля, пришедшая от немца и от
   * испанца, становится двумя ситуациями, и за год таблица превращается
   * в пять параллельных корпусов — ровно противоположность накоплению.
   *
   * Текст пишет ОПЕРАТОР, а не копируется из жалобы: сырой сигнал
   * советом не становится никогда (§6.2).
   */
  async attachText(
    candidateId: string,
    experienceId: string,
    input: TextInput,
    operatorId: string,
  ): Promise<ExperienceView> {
    const candidate = await this.candidate(candidateId, 'NEW');
    // Ситуация проверяется ДО записи текста: иначе несуществующий
    // `experienceId` оставил бы текст висеть без владельца.
    await this.one(experienceId);
    await this.saveText(experienceId, candidate.locale, input);
    await this.merge(candidateId, experienceId, operatorId);
    return this.one(experienceId);
  }

  async reject(candidateId: string, operatorId: string): Promise<{ ok: true }> {
    await this.candidate(candidateId, 'NEW');
    await this.prisma.wizardExperienceCandidate.update({
      where: { id: candidateId },
      data: { status: 'REJECTED', decidedBy: operatorId },
    });
    return { ok: true };
  }

  /** Запись оператора без всякого сигнала — основной источник на старте. */
  async addCandidate(input: {
    scenario: string;
    stepId: string;
    locale: string;
    rawText: string;
  }): Promise<{ id: string }> {
    return this.prisma.wizardExperienceCandidate.create({
      data: { ...input, origin: 'ADMIN' },
      select: { id: true },
    });
  }

  /**
   * Кандидат в ожидаемом состоянии.
   *
   * Состояние проверяется ВСЕГДА, и это не формальность: двойной клик
   * по «Свести» на медленной сети поднимал бы `occurrences` дважды за
   * один сигнал — а по этому счётчику сортируется срез корпуса, то есть
   * ошибка не остаётся косметической. По той же причине нельзя
   * завести две ситуации из одного кандидата.
   */
  private async candidate(
    id: string,
    expected: 'NEW' | 'MERGED',
  ): Promise<{
    id: string;
    scenario: string;
    stepId: string;
    locale: string;
    status: string;
    matchedId: string | null;
    decision: string | null;
  }> {
    const row = await this.prisma.wizardExperienceCandidate.findUnique({
      where: { id },
      select: {
        id: true,
        scenario: true,
        stepId: true,
        locale: true,
        status: true,
        matchedId: true,
        decision: true,
      },
    });
    if (!row) throw new NotFoundException(`Кандидат ${id} не найден`);
    if (row.status !== expected) {
      throw new ConflictException(
        `Кандидат уже разобран (${row.status}) — обновите очередь.`,
      );
    }
    return row;
  }

  private assertLocale(locale: string): void {
    if (!SUPPORTED_LOCALES.includes(locale as never))
      throw new BadRequestException(`Неизвестная локаль: ${locale}`);
  }

  /**
   * Проверка текста перед сохранением.
   *
   * Неизвестный ключ словаря отвергается СРАЗУ, а не всплывает молчанием
   * в подсказке: опечатка в ключе — самая частая ошибка при наборе
   * текста, и ловить её через «почему-то этой записи нет в советах»
   * дороже, чем через отказ формы.
   */
  private assertText(input: TextInput): void {
    if (!input.symptom.trim() || !input.advice.trim())
      throw new BadRequestException('Нужны симптом и совет');
    const keys = uiKeysOf(
      [input.symptom, input.cause ?? '', input.advice].join('\n'),
    );
    const unknown = keys.filter((k) => !isKnownUiKey(k));
    if (unknown.length)
      throw new BadRequestException(
        `Неизвестные ключи словаря: ${unknown.join(', ')}`,
      );
  }
}
