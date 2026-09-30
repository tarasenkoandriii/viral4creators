/**
 * Карточка «Квота образов «Я в кадре»» на вкладке /settings — ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4.2 и решение
 * В-7 (временно по рекомендации ТЗ): сколько новых образов персоны в
 * сутки и в месяц даёт тариф.
 *
 * Тонкая обёртка над `PlatformSettingsService`, как карточка «Голосовой
 * помощник»: правила разбора живут в `common/plans.ts`
 * (`personaLookQuotaFor`) — им же пользуется сама квота
 * (`persona-looks.service.ts`). Одна грамматика на запись и на чтение —
 * иначе админка показала бы одно, а работало бы другое.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import {
  PERSONA_LOOK_QUOTA_DEFAULTS,
  PERSONA_LOOK_QUOTA_SETTING_KEYS,
  PLAN_IDS,
  PlanId,
  personaLookQuotaFor,
} from '../../common/plans';

export type PersonaLookQuotaPeriod = 'day' | 'month';
const PERIODS: readonly PersonaLookQuotaPeriod[] = ['day', 'month'];

/** Верхняя граница — от опечатки на лишний ноль, а не бизнес-правило. */
export const PERSONA_LOOK_QUOTA_MAX = 1000;

export function isValidPersonaLookQuota(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= PERSONA_LOOK_QUOTA_MAX
  );
}

/** Настройка задана и читается квотой как число — то есть действует. */
export function isStoredQuota(stored: string | null): boolean {
  if (stored === null || stored.trim() === '') return false;
  const n = Number(stored);
  return Number.isInteger(n) && n >= 0;
}

export interface PersonaLookQuotaCell {
  /** Действующее значение. */
  value: number;
  /** Умолчание В-7. */
  defaultValue: number;
  source: 'admin' | 'default';
}

export type PersonaLookQuotaSettingsView = Record<
  PlanId,
  Record<PersonaLookQuotaPeriod, PersonaLookQuotaCell>
>;

/** Не присланное не трогается. */
export type SetPersonaLookQuotaInput = Partial<
  Record<PlanId, Partial<Record<PersonaLookQuotaPeriod, number>>>
>;

@Injectable()
export class AdminPersonaLookQuotaSettingsService {
  constructor(private readonly settings: PlatformSettingsService) {}

  async view(): Promise<PersonaLookQuotaSettingsView> {
    const out = {} as PersonaLookQuotaSettingsView;
    for (const plan of PLAN_IDS) {
      const keys = PERSONA_LOOK_QUOTA_SETTING_KEYS[plan];
      const day = await this.settings.get(keys.day);
      const month = await this.settings.get(keys.month);
      const effective = personaLookQuotaFor(plan, { day, month });
      const stored = { day, month };
      out[plan] = {} as Record<PersonaLookQuotaPeriod, PersonaLookQuotaCell>;
      for (const period of PERIODS) {
        out[plan][period] = {
          value: effective[period],
          defaultValue: PERSONA_LOOK_QUOTA_DEFAULTS[plan][period],
          // Мусор в настройке квота читает как умолчание — и показывается
          // здесь им же, а не «задано оператором».
          source: isStoredQuota(stored[period]) ? 'admin' : 'default',
        };
      }
    }
    return out;
  }

  async set(
    input: SetPersonaLookQuotaInput,
    updatedBy: string,
  ): Promise<PersonaLookQuotaSettingsView> {
    // Проверка ВСЕГО ввода до первой записи: половина сохранённого
    // запроса хуже отказа целиком.
    const writes: Array<[string, number]> = [];
    for (const [plan, periods] of Object.entries(input ?? {})) {
      if (periods === undefined || periods === null) continue;
      if (!(PLAN_IDS as readonly string[]).includes(plan)) {
        throw new BadRequestException(`Неизвестный тариф: ${plan}`);
      }
      for (const [period, value] of Object.entries(periods)) {
        if (value === undefined) continue;
        if (!(PERIODS as readonly string[]).includes(period)) {
          throw new BadRequestException(`Неизвестный период: ${period}`);
        }
        if (!isValidPersonaLookQuota(value)) {
          throw new BadRequestException(
            `Квота образов для ${plan} (${period}) — целое число от 0 до ${PERSONA_LOOK_QUOTA_MAX}`,
          );
        }
        writes.push([
          PERSONA_LOOK_QUOTA_SETTING_KEYS[plan as PlanId][
            period as PersonaLookQuotaPeriod
          ],
          value,
        ]);
      }
    }
    for (const [key, value] of writes) {
      await this.settings.set(key, String(value), updatedBy);
    }
    return this.view();
  }
}
