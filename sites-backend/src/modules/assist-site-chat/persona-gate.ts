/**
 * Проверка персоны перед публикацией — W3 (ТЗ §4-тер.8, строка «Персона,
 * запреты, примеры»): инвариантный поднабор платформы (10 кейсов Э1,
 * assist-knowledge-core/eval/invariant-cases.ts) + до 30 кейсов сайта с
 * НОВОЙ персоной через тот же конвейер (фейк-модель в тестах). Провал
 * инвариантов блокирует; падение доли верных > 10 п.п. — предупреждение.
 * Платит бюджет обучения (assist-eval); нет бюджета — ran=false, не блок.
 * Зовёт W4 (PersonaService.publish).
 *
 * Реализация — system/persona-gate.runner.ts: кейсы сайта и бюджет обучения
 * читаются основной ролью (кабинетная операция), а публичная зона модуля
 * клиентов основной роли не импортирует (правило графа `public-db`).
 */
import { Injectable } from '@nestjs/common';
import type { PersonaGateView } from '../assist-site-setup/api-types';
import type { PersonaConfig } from '../assist-site-setup/persona';
import { PersonaGateRunner } from './system/persona-gate.runner';

@Injectable()
export class PersonaGate {
  constructor(private readonly runner: PersonaGateRunner) {}

  check(
    ctx: { accountId: string; siteId: string },
    persona: PersonaConfig,
  ): Promise<PersonaGateView> {
    return this.runner.check(ctx, persona);
  }
}
