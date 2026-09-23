/**
 * Запись и чтение телеметрии шагов — «Тонкая красная линия» §8, §10.
 *
 * Запись НИКОГДА не роняет запрос: телеметрия — наблюдение за
 * продуктом, а не часть пути человека, и упавшая вставка не должна
 * превращаться в ошибку на экране мастера. Тот же приём, что у
 * событий лендингового виджета.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  WIZARD_EVENT_DETAIL_MAX,
  WIZARD_EVENT_KINDS,
  type WizardEventKind,
} from './wizard-telemetry';

export interface WizardStepEventInput {
  scenario: string;
  stepId: string;
  kind: WizardEventKind;
  detail?: string | null;
}

/** Строка сводки для админки: сколько раз что случилось на шаге. */
export interface StepFrequencyRow {
  scenario: string;
  stepId: string;
  counts: Record<string, number>;
  total: number;
}

@Injectable()
export class WizardTelemetryService {
  private readonly logger = new Logger(WizardTelemetryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** @returns сколько событий записано (0 — молчаливый отказ). */
  async record(events: WizardStepEventInput[]): Promise<number> {
    const rows = events
      .filter((e) => WIZARD_EVENT_KINDS.includes(e.kind))
      .map((e) => ({
        scenario: e.scenario.slice(0, 40),
        stepId: e.stepId.slice(0, 40),
        kind: e.kind,
        // Обрезка, а не отказ: `detail` — машинный признак, и слишком
        // длинный означает ошибку вызывающего, а не повод потерять
        // событие целиком.
        detail: e.detail ? e.detail.slice(0, WIZARD_EVENT_DETAIL_MAX) : null,
      }));
    if (!rows.length) return 0;
    try {
      await this.prisma.wizardStepEvent.createMany({ data: rows });
      return rows.length;
    } catch (e) {
      this.logger.warn(`телеметрия шагов не записана: ${String(e)}`);
      return 0;
    }
  }

  /**
   * Частоты по шагам за последние `days` суток.
   *
   * Группировка в базе, а не в памяти: таблица растёт по числу шагов на
   * число входов в мастер, и вытаскивать её целиком ради шести чисел
   * было бы тем же самым, что считать сумму заказов выборкой всех строк.
   */
  async frequencies(days = 7): Promise<StepFrequencyRow[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    // Тип НЕ аннотацией слева, а приведением справа — и это не
    // вкусовщина. У `groupBy` в сгенерированном клиенте перегрузка,
    // которая при ожидаемом типе слева выбирает не ту сигнатуру и
    // требует от аргумента быть массивом результата. В песочнице
    // разработки клиент подменён на `any`, поэтому такая ошибка не
    // видна ни тестами, ни `tsc` — она ждёт прод-сборки (и дождалась).
    const grouped = (await this.prisma.wizardStepEvent.groupBy({
      by: ['scenario', 'stepId', 'kind'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    })) as unknown as Array<{
      scenario: string;
      stepId: string;
      kind: string;
      _count: { _all: number };
    }>;

    const rows = new Map<string, StepFrequencyRow>();
    for (const g of grouped) {
      const key = `${g.scenario}|${g.stepId}`;
      const row = rows.get(key) ?? {
        scenario: g.scenario,
        stepId: g.stepId,
        counts: {},
        total: 0,
      };
      row.counts[g.kind] = (row.counts[g.kind] ?? 0) + g._count._all;
      row.total += g._count._all;
      rows.set(key, row);
    }
    // Сортировка по общему числу — самый посещаемый шаг первым: оператор смотрит
    // сверху вниз и должен видеть, где людей больше всего.
    return [...rows.values()].sort((a, b) => b.total - a.total);
  }
}
