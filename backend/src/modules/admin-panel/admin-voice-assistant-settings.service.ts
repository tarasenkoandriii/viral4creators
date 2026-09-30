/**
 * Карточка «Голосовой помощник» на вкладке /settings — ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.4 (В-11,
 * голос помощника — отдельный пресет) и §4А.7.5 (В-14, суточный потолок
 * голоса по тарифу — «настройки в админке, как сами суточные лимиты»).
 *
 * Тонкая обёртка над `PlatformSettingsService`, как соседние карточки:
 * правила живут не здесь. Потолки разбирает `voice-budget/voice-budget.ts`
 * (им же пользуется сам потолок), пресет голоса — `wizard-guide/
 * hint-audio.ts` (им же пользуется озвучка советника). Одна грамматика
 * на запись и на чтение — иначе админка показала бы одно, а работало бы
 * другое.
 *
 * Витрина показывает и «а сработает ли»: голос провайдера без ключа на
 * стенде выглядел бы выбранным и молчал бы.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { PLAN_IDS, PlanId } from '../../common/plans';
import {
  VOICE_DAILY_CAP_ANONYMOUS_DEFAULT_USD,
  VOICE_DAILY_CAP_ANONYMOUS_SETTING_KEY,
  VOICE_DAILY_CAP_DEFAULT_USD,
  VOICE_DAILY_CAP_SETTING_KEYS,
  voiceAnonymousCapMicroUsd,
  isValidVoiceCapUsd,
  voiceCapMicroUsd,
} from '../voice-budget/voice-budget';
import {
  EXPLICIT_TTS_PROVIDER_KEYS,
  ExplicitTtsProviderKey,
} from '../tts/default-tts-provider';
import {
  VOICE_ASSISTANT_VOICE_KEY,
  parseAssistantVoice,
} from '../wizard-guide/hint-audio';
import { AdminVoiceoverSettingsService } from './admin-voiceover-settings.service';

/**
 * Строка потолка: тариф или `ANONYMOUS` — общий потолок сессий без
 * владельца (умолчание 0 — голос без входа выключен, аудит волны K).
 */
export type VoiceCapKey = PlanId | 'ANONYMOUS';
export const VOICE_CAP_KEYS: readonly VoiceCapKey[] = [
  ...PLAN_IDS,
  'ANONYMOUS',
];

const CAP_SETTING_KEY: Readonly<Record<VoiceCapKey, string>> = {
  ...VOICE_DAILY_CAP_SETTING_KEYS,
  ANONYMOUS: VOICE_DAILY_CAP_ANONYMOUS_SETTING_KEY,
};

function capMicroUsd(key: VoiceCapKey, stored: string | null): number {
  return key === 'ANONYMOUS'
    ? voiceAnonymousCapMicroUsd(stored)
    : voiceCapMicroUsd(key, stored);
}

function defaultCapUsd(key: VoiceCapKey): number {
  return key === 'ANONYMOUS'
    ? VOICE_DAILY_CAP_ANONYMOUS_DEFAULT_USD
    : VOICE_DAILY_CAP_DEFAULT_USD[key];
}

export interface VoiceAssistantCapView {
  /** Действующий потолок, USD в сутки UTC. */
  usd: number;
  /** Умолчание В-14 для тарифа. */
  defaultUsd: number;
  /** `admin` — задано здесь; `default` — не менялось. */
  source: 'admin' | 'default';
}

export interface VoiceAssistantSettingsView {
  caps: Record<VoiceCapKey, VoiceAssistantCapView>;
  voice: {
    provider: ExplicitTtsProviderKey;
    /** `null` — голос провайдера по умолчанию. */
    voiceId: string | null;
    source: 'admin' | 'default';
  };
  providers: Array<{ key: ExplicitTtsProviderKey; configured: boolean }>;
}

export interface SetVoiceAssistantInput {
  /** Потолки в долларах; не прислан тариф — не трогаем. */
  caps?: Partial<Record<VoiceCapKey, number>>;
  /** Пресет голоса; `null` — вернуть умолчание. */
  voice?: { provider: string; voiceId?: string | null } | null;
}

/** Настройка потолка задана и читается как число — то есть действует. */
export function isStoredCap(stored: string | null): boolean {
  if (stored === null || stored.trim() === '') return false;
  const n = Number(stored);
  return Number.isFinite(n) && n >= 0;
}

/** Пресет голоса задан и разбирается — иначе действует умолчание. */
export function isStoredVoice(raw: string | null): boolean {
  if (!raw?.trim()) return false;
  try {
    const p = JSON.parse(raw) as { provider?: unknown } | null;
    return (
      !!p &&
      typeof p.provider === 'string' &&
      (EXPLICIT_TTS_PROVIDER_KEYS as readonly string[]).includes(p.provider)
    );
  } catch {
    return false;
  }
}

@Injectable()
export class AdminVoiceAssistantSettingsService {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly voiceover: AdminVoiceoverSettingsService,
  ) {}

  async view(): Promise<VoiceAssistantSettingsView> {
    const caps = {} as Record<VoiceCapKey, VoiceAssistantCapView>;
    for (const plan of VOICE_CAP_KEYS) {
      const stored = await this.settings.get(CAP_SETTING_KEY[plan]);
      caps[plan] = {
        usd: capMicroUsd(plan, stored) / 1_000_000,
        defaultUsd: defaultCapUsd(plan),
        // Мусор в настройке читается потолком как умолчание — и
        // показывается здесь им же, а не «задано оператором».
        source: isStoredCap(stored) ? 'admin' : 'default',
      };
    }
    const rawVoice = await this.settings.get(VOICE_ASSISTANT_VOICE_KEY);
    const voice = parseAssistantVoice(rawVoice);
    const configured = new Map(
      (await this.voiceover.get()).options.map((o) => [o.key, o.configured]),
    );
    return {
      caps,
      voice: {
        ...voice,
        source: isStoredVoice(rawVoice) ? 'admin' : 'default',
      },
      providers: EXPLICIT_TTS_PROVIDER_KEYS.map((key) => ({
        key,
        configured: configured.get(key) ?? false,
      })),
    };
  }

  async set(
    input: SetVoiceAssistantInput,
    updatedBy: string,
  ): Promise<VoiceAssistantSettingsView> {
    // Проверка ВСЕГО ввода до первой записи: половина сохранённого
    // запроса хуже отказа целиком.
    // `undefined` — «не трогать»: экземпляр DTO может нести объявленные,
    // но не присланные поля.
    const caps = (
      Object.entries(input.caps ?? {}) as Array<
        [VoiceCapKey, number | undefined]
      >
    ).filter((e): e is [VoiceCapKey, number] => e[1] !== undefined);
    for (const [plan, usd] of caps) {
      if (!(VOICE_CAP_KEYS as readonly string[]).includes(plan)) {
        throw new BadRequestException(`Неизвестный тариф: ${plan}`);
      }
      if (!isValidVoiceCapUsd(usd)) {
        throw new BadRequestException(
          `Потолок голоса для ${plan} — число долларов от 0 до 1000`,
        );
      }
    }
    let voiceValue: string | undefined;
    if (input.voice === null) {
      // Пустая строка — «не задано»: озвучка советника читает умолчание.
      voiceValue = '';
    } else if (input.voice !== undefined) {
      const provider = input.voice.provider;
      if (
        !(EXPLICIT_TTS_PROVIDER_KEYS as readonly string[]).includes(provider)
      ) {
        throw new BadRequestException(
          `Неизвестный провайдер голоса помощника: ${provider}`,
        );
      }
      const voiceId = input.voice.voiceId?.trim() || null;
      voiceValue = JSON.stringify({ provider, voiceId });
    }

    for (const [plan, usd] of caps) {
      await this.settings.set(CAP_SETTING_KEY[plan], String(usd), updatedBy);
    }
    if (voiceValue !== undefined) {
      await this.settings.set(VOICE_ASSISTANT_VOICE_KEY, voiceValue, updatedBy);
    }
    return this.view();
  }
}
