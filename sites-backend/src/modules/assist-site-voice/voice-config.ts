/**
 * Голос виджета «Сайта» — настройки и умолчания Э5 (ТЗ помощника §3.5,
 * §4.10, §4-бис.6, §5-бис.7, §7.1–§7.3; план, Приложение А «Этап 5»).
 * Чистый модуль: его читают публичный код голоса (`public/`), кабинет
 * (`cabinet/`), конфиг виджета (assist-widget) и TMA (повтор типов).
 *
 * Где хранится и почему не в персоне. ТЗ §3.5 ставит выбор голоса на экран
 * персоны — там он и показан в TMA. Но опубликованная персона — это блок
 * промпта: её публикация гоняет ворота eval (деньги бюджета обучения) и
 * меняет ключ семантического кэша (`configVersion`). Включение микрофона и
 * смена голоса на ответы модели не влияют, поэтому они лежат отдельно —
 * `assist_sites.voiceConfig`, действуют сразу (как настройки лидов Э2).
 */
import type { AssistPlanId } from '../assist-billing/plans';
import { DIALOG_BASE_UNITS } from '../assist-billing/units';

export interface VoiceConfig {
  schema: 1;
  /** Микрофон в виджете: вопрос голосом → Soniox → текст (§4.10 «Ввод»). */
  input: boolean;
  /** Кнопка «озвучить ответ» (§4.10 «Вывод»). */
  output: boolean;
  /** Голос озвучки из справочника провайдера; null — голос по умолчанию. */
  voiceId: string | null;
}

export type VoiceConfigParse =
  | { ok: true; config: VoiceConfig }
  | { ok: false; errors: Array<{ path: string; code: string }> };

/** Голос по умолчанию выключен (§4.10: «включается на тарифе Business+»). */
export function defaultVoiceConfig(): VoiceConfig {
  return { schema: 1, input: false, output: false, voiceId: null };
}

/** Имя голоса провайдера: буквы/цифры/пробел/._- — в заголовок и ключ кэша. */
export const VOICE_ID = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Строгий разбор: лишние ключи — ошибка (владелец не должен гадать, что они включают). */
export function parseVoiceConfig(input: unknown): VoiceConfigParse {
  if (!isObj(input)) return { ok: false, errors: [{ path: '', code: 'type' }] };
  const errors: Array<{ path: string; code: string }> = [];
  for (const k of Object.keys(input)) {
    if (!['schema', 'input', 'output', 'voiceId'].includes(k)) {
      errors.push({ path: k, code: 'unknown' });
    }
  }
  if (input.schema !== undefined && input.schema !== 1) {
    errors.push({ path: 'schema', code: 'schema' });
  }
  for (const k of ['input', 'output'] as const) {
    if (typeof input[k] !== 'boolean') errors.push({ path: k, code: 'type' });
  }
  const v = input.voiceId;
  if (
    v !== undefined &&
    v !== null &&
    (typeof v !== 'string' || !VOICE_ID.test(v))
  ) {
    errors.push({ path: 'voiceId', code: 'format' });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: {
      schema: 1,
      input: input.input as boolean,
      output: input.output as boolean,
      voiceId: typeof v === 'string' ? v : null,
    },
  };
}

/** Сохранённая настройка (может быть мусором старой версии) → конфиг; мусор — выключено. */
export function voiceConfigOf(raw: unknown): VoiceConfig {
  if (raw === null || raw === undefined) return defaultVoiceConfig();
  const p = parseVoiceConfig(raw);
  return p.ok ? p.config : defaultVoiceConfig();
}

const USD = 1_000_000;

/**
 * Умолчания голоса. Числа — ориентиры ТЗ с причиной; менять — здесь.
 */
export const VOICE_DEFAULTS = {
  /** Запись — до 30 с (§4.10 «MediaRecorder, до 30 с»). */
  maxRecordMs: 30_000,
  /**
   * Потолок тела записи. 30 с Opus ≈ 120–240 КБ, AAC/mp4 iOS Safari — до
   * ≈ 500 КБ; 1 МБ с запасом и далеко от 4.5 МБ функции Vercel.
   */
  maxAudioBytes: 1024 * 1024,
  /** Меньше — заведомо не речь (заголовок контейнера без звука). */
  minAudioBytes: 512,
  /**
   * Фраза короче 0.4 с отбрасывается на устройстве (§5-бис.7: строже, чем
   * minSpeechMs 150 в TMA — короткий шум не должен становиться вопросом).
   */
  minSpeechMs: 400,
  /** Конец фразы — тишина ~1 с (детектор `voice-listen.ts` TMA, §5-бис.7). */
  endSilenceMs: 1_000,
  /** Распознаваний на посетителя: в сутки и в минуту (§4.10 «не больше N»). */
  sttPerVisitorPerDay: 30,
  sttPerVisitorPerMinute: 6,
  /** Озвучек на посетителя: в сутки и в минуту (озвучка дороже распознавания). */
  ttsPerVisitorPerDay: 60,
  ttsPerVisitorPerMinute: 12,
  /**
   * Те же лимиты на ipHash+сайт (как `widget-msg-ip-site-min` чата: втрое
   * выше посетительского — офис за одним NAT): смена visitor-token (новая
   * сессия — 5/мин на IP) не открывает новые сутки распознаваний.
   */
  sttPerIpPerDay: 90,
  sttPerIpPerMinute: 18,
  ttsPerIpPerDay: 180,
  ttsPerIpPerMinute: 36,
  /**
   * Озвучивается не больше 1 200 символов ответа: ответ виджета ≤ 800
   * токенов, но 1 200 символов ≈ 1.5 мин речи — дальше посетитель читает.
   */
  ttsMaxChars: 1_200,
  /** Кэш озвучки — 7 дней (§4.10: «FAQ-ответы повторяются»). */
  ttsCacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** Билет голоса живёт 10 минут: распознал → показал → отправил. */
  ticketTtlMs: 10 * 60 * 1000,
  /**
   * Срок одной попытки распознавания у Soniox. Короче, чем у генератора
   * (20 с): посетитель ждёт с кнопкой «слушаю», а запись не длиннее 30 с.
   */
  sttAttemptDeadlineMs: 15_000,
  /** Резерв денег на распознавание — по потолку записи с запасом (сверху). */
  sttReserveSeconds: 35,
  /** Вес диалога с голосом (§7.1, Р-58; озвучка Soniox — не Resemble). */
  dialogUnits: DIALOG_BASE_UNITS.voice,
  /**
   * Суточный денежный потолок голоса сайта по тарифу (§4.10 «по образцу
   * VoiceCapKey»; §7.1 «ловит сбой, а не честного посетителя»): месячная
   * себестоимость голоса на весь лимит единиц / 10. Business: 1 200 ед. =
   * 600 голосовых диалогов × (4 озвучки Soniox ≈ $0.02 + 4 распознавания ≈
   * $0.002) ≈ $13 → $1.5 в сутки; Pro: 1 500 диалогов ≈ $33 → $4. Голоса
   * нет на тарифе — 0 (маршрут откажет раньше). ПРОВЕРИТЬ на пилотах (вопрос
   * владельцу).
   */
  dailyCapMicroUsdByPlan: {
    trial: 0,
    start: 0,
    business: 1.5 * USD,
    pro: 4 * USD,
  } satisfies Record<AssistPlanId, number>,
  /**
   * Форматы записи. Chrome/Firefox — webm/ogg (Opus), Safari и iOS — mp4
   * (AAC); wav — тестовая подача звука и старые браузеры. Soniox по своей
   * документации принимает все эти контейнеры — ПРОВЕРИТЬ живым ключом
   * (особенно mp4 из iOS Safari).
   */
  audioMimes: [
    'audio/webm',
    'audio/ogg',
    'audio/mp4',
    'audio/aac',
    'audio/mpeg',
    'audio/wav',
    'audio/x-wav',
  ] as const,
} as const;

export type AudioMime = (typeof VOICE_DEFAULTS.audioMimes)[number];

/** `audio/webm;codecs=opus` → `audio/webm`; неизвестное — null. */
export function audioMimeOf(raw: unknown): AudioMime | null {
  if (typeof raw !== 'string') return null;
  const base = raw.split(';')[0].trim().toLowerCase();
  return (VOICE_DEFAULTS.audioMimes as readonly string[]).includes(base)
    ? (base as AudioMime)
    : null;
}

/**
 * Контейнер записи по первым байтам — заголовку `Content-Type` не верим
 * (как `sniffImage` ассетов Э2): провайдеру уходят только байты, которые
 * хотя бы начинаются как звук, и с ТЕМ типом, что в них на самом деле.
 * Не звук — null (AUDIO_INVALID до денег и провайдера).
 *   webm/Matroska — EBML `1A 45 DF A3`; ogg — `OggS`; mp4/m4a — `ftyp` с 4-го
 *   байта; wav — `RIFF….WAVE`; AAC ADTS — синхрослово `FFF` со слоем 00;
 *   mp3 — `ID3` или кадр MPEG (синхрослово `FFE`).
 */
export function sniffAudio(b: Buffer): AudioMime | null {
  if (b.length < 12) return null;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return 'audio/webm';
  }
  const ascii = (from: number, to: number) => b.toString('latin1', from, to);
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

/**
 * Суточный потолок голоса сайта: ручная колонка (оператор платформы) или
 * по тарифу. Нет тарифа — 0.
 */
export function voiceDailyCapMicroUsd(
  override: number | null | undefined,
  planId: AssistPlanId | null,
): number {
  if (!planId) return 0;
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(0, Math.floor(override));
  }
  return VOICE_DEFAULTS.dailyCapMicroUsdByPlan[planId];
}
