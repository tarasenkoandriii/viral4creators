/**
 * Корпус опыта: чтение для подсказки и приём сигналов с поля —
 * «Тонкая красная линия» §6, этап 9.
 *
 * ## Что здесь есть и чего нет
 *
 * Здесь — срез корпуса под шаг (его читает `WizardHintService`) и приём
 * кандидатов (жалоба человека, откат, отказ). Модерация, очередь и
 * публикация — в `admin-experience.service.ts`: у них разные вызывающие
 * и разные права, и смешивать в одном классе «то, что видит
 * пользователь» и «то, что делает оператор» — прямой путь к тому, чтобы
 * однажды отдать одно вместо другого.
 *
 * ## Почему корпус читается из базы, а не собирается в файл
 *
 * ТЗ §6.5 предлагало публикацию через пересборку корпуса и деплой (по
 * образцу `generated.ts`). Реализация выбрала базу, и это осознанное
 * решение аудита волны C: этап 11 («накопление локалей») по построению
 * пишет переводы В РАНТАЙМЕ и тут же их отдаёт — с корпусом-файлом
 * перевод, сохранённый в базу, не доехал бы до людей никогда. Гарантия,
 * ради которой затевался деплойный путь, сохранена другим способом:
 * пользователю отдаётся только `PUBLISHED`, а публикация невозможна без
 * русского совета, ПРОЧИТАННОГО человеком (§6.5, `canPublish`).
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { maskSensitiveEcho } from '../assistant/post-filter';
import { renderUiKeys } from './ui-keys';
import {
  experienceLine,
  serveDecision,
  type CandidateOrigin,
  type ExperienceText,
} from './experience';

/** Сколько записей опыта берём в срез (§5.6). */
export const EXPERIENCE_SLICE_LIMIT = 5;

/** Длина сырого сигнала. Жалоба — пара фраз, а не сочинение. */
export const CANDIDATE_TEXT_MAX = 1000;

/**
 * Сколько НЕРАЗОБРАННЫХ сигналов держим на одном шаге.
 *
 * Очередь оператора — рабочий список, а не журнал: за двухсотым
 * неразобранным сигналом на одном шаге двести первый не добавляет
 * ничего, кроме шума, — и кроме строк в таблице, которую никто не
 * чистит. Заодно это потолок для дурного сценария: жалоба приходит с
 * формы, и частотный лимит на маршруте ограничивает темп, но не общий
 * объём (найдено аудитом волны C).
 */
export const CANDIDATE_QUEUE_MAX = 200;

export interface ExperienceRow {
  id: string;
  occurrences: number;
  updatedAt: Date;
  texts: Array<ExperienceText & { updatedAt: Date }>;
}

export interface SliceResult {
  /** Готовые строки для промпта, уже с подставленными подписями. */
  lines: string[];
  /**
   * Ситуации, у которых на этой локали текста нет, — их надо перевести
   * (этап 11). На этапе 9 список просто не используется.
   */
  needTranslation: Array<{ id: string; from: ExperienceText }>;
  /** Отпечаток состояния корпуса — часть ключа кеша (§5.5). */
  stamp: string;
}

@Injectable()
export class ExperienceService {
  private readonly logger = new Logger(ExperienceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Срез корпуса под шаг.
   *
   * Сортировка по `occurrences` — прямое требование §5.6: в промпт
   * попадает то, что случается чаще, а не то, что завели раньше.
   */
  async sliceFor(
    scenario: string,
    stepId: string,
    locale: string,
  ): Promise<SliceResult> {
    const rows = await this.published(scenario, stepId);
    const lines: string[] = [];
    const needTranslation: Array<{ id: string; from: ExperienceText }> = [];

    for (const row of rows) {
      const decision = serveDecision(row.texts, locale);
      if (decision.kind === 'translate') {
        needTranslation.push({ id: row.id, from: decision.from });
        continue;
      }
      if (decision.kind === 'none') continue;
      const line = this.renderLine(decision.text, locale, row.id);
      if (line) lines.push(line);
      if (lines.length >= EXPERIENCE_SLICE_LIMIT) break;
    }

    return { lines, needTranslation, stamp: this.stampOf(rows) };
  }

  /**
   * Опубликованные ситуации шага, самые частые первыми.
   *
   * Берётся с запасом к `EXPERIENCE_SLICE_LIMIT`: часть записей отпадёт
   * на подстановке ключей или уедет в перевод, и добирать их вторым
   * запросом дороже, чем прочитать на несколько строк больше.
   */
  private async published(
    scenario: string,
    stepId: string,
  ): Promise<ExperienceRow[]> {
    return this.prisma.wizardExperience.findMany({
      where: { scenario, stepId, status: 'PUBLISHED' },
      orderBy: [{ occurrences: 'desc' }, { updatedAt: 'desc' }],
      take: EXPERIENCE_SLICE_LIMIT * 3,
      select: {
        id: true,
        occurrences: true,
        updatedAt: true,
        texts: {
          select: {
            locale: true,
            symptom: true,
            cause: true,
            advice: true,
            source: true,
            reviewed: true,
            // Время правки ТЕКСТА — часть отпечатка: `updatedAt` самой
            // ситуации от правки совета не меняется, и без этого поля
            // исправленный оператором текст продолжал бы выдаваться из
            // кеша целые сутки (аудит волны C).
            updatedAt: true,
          },
        },
      },
    }) as unknown as Promise<ExperienceRow[]>;
  }

  /**
   * Текст записи с подставленными подписями интерфейса.
   *
   * Неизвестный ключ выбрасывает запись ЦЕЛИКОМ, а не подставляет
   * что-нибудь: приёмка §9 требует, чтобы такая ситуация помечалась
   * оператору, а не уезжала в промпт. В админке она видна фильтром
   * «битые ключи»; здесь — просто молчание, потому что человек в
   * мастере за наши переименования не отвечает.
   */
  private renderLine(
    text: ExperienceText,
    locale: string,
    experienceId: string,
  ): string | null {
    const symptom = renderUiKeys(text.symptom, locale);
    const cause = renderUiKeys(text.cause ?? '', locale);
    const advice = renderUiKeys(text.advice, locale);
    const unknown = [...symptom.unknown, ...cause.unknown, ...advice.unknown];
    if (unknown.length) {
      this.logger.warn(
        `запись опыта ${experienceId}: неизвестные ключи словаря ${unknown.join(', ')} — в подсказку не идёт`,
      );
      return null;
    }
    return experienceLine({
      ...text,
      symptom: symptom.text,
      cause: cause.text,
      advice: advice.text,
    });
  }

  /**
   * Отпечаток корпуса шага — чтобы публикация доехала до людей сразу,
   * а не через сутки.
   *
   * Ключ кеша подсказок держит штамп знаний (§5.5). Пока корпус жил
   * только в коде, его меняла пересборка; теперь записи публикуются в
   * базе, и без этого отпечатка новая запись ждала бы истечения
   * суточного TTL — то есть модерация «работала» бы с задержкой в день,
   * и никто бы не понял почему.
   */
  private stampOf(rows: ExperienceRow[]): string {
    if (!rows.length) return 'e0';
    const newest = rows.reduce(
      (max, r) =>
        r.texts.reduce(
          (inner, t) => Math.max(inner, t.updatedAt?.getTime() ?? 0),
          Math.max(max, r.updatedAt.getTime()),
        ),
      0,
    );
    const occurrences = rows.reduce((sum, r) => sum + r.occurrences, 0);
    return `e${rows.length}.${occurrences}.${newest.toString(36)}`;
  }

  /**
   * Сигнал с поля.
   *
   * Три вещи здесь обязательны и все три — из §9:
   *  - текст МАСКИРУЕТСЯ перед сохранением: человек, описывая проблему
   *    входа, вполне может вписать туда свою почту;
   *  - идентификатора автора нет и не будет: жалоба про шаг, а не про
   *    человека;
   *  - пользователю этот текст не показывается никогда — он живёт в
   *    своей таблице, а в подсказку уходит совет оператора.
   */
  async addCandidate(input: {
    scenario: string;
    stepId: string;
    locale: string;
    rawText: string;
    origin: CandidateOrigin;
  }): Promise<{ id: string } | null> {
    const rawText = maskSensitiveEcho(input.rawText.trim()).slice(
      0,
      CANDIDATE_TEXT_MAX,
    );
    // Пустой сигнал не заводится: «человеку непонятно на этом шаге» уже
    // посчитано телеметрией (`hint_useless`), а кандидат без слов
    // оператору нечего дать.
    if (!rawText) return null;
    try {
      const waiting = await this.prisma.wizardExperienceCandidate.count({
        where: {
          scenario: input.scenario,
          stepId: input.stepId,
          status: 'NEW',
        },
      });
      if (waiting >= CANDIDATE_QUEUE_MAX) {
        this.logger.warn(
          `очередь кандидатов шага ${input.scenario}/${input.stepId} заполнена (${waiting}) — сигнал не записан`,
        );
        return null;
      }
      const row: { id: string } =
        await this.prisma.wizardExperienceCandidate.create({
          data: {
            scenario: input.scenario,
            stepId: input.stepId,
            locale: input.locale,
            rawText,
            origin: input.origin,
          },
          select: { id: true },
        });
      return row;
    } catch (e) {
      this.logger.warn(`кандидат опыта не записан: ${String(e)}`);
      return null;
    }
  }
}
