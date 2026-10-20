/**
 * Чистая логика видеопанели Story‑Tales (WP4, §23.7): тело запроса сборки
 * и сметы, произношения (ST‑P2), подготовка собственной записи вступления
 * (ST‑P1) и строки сметы повторного заказа. Без DOM и сети — проверяется
 * `scripts/story-video-plan.test.ts`.
 */
import {
  downmixToMono,
  encodeWavPcm16,
  resampleLinear,
  type DecodedAudioLike,
} from '../../lib/wav';
import ru from '../../dictionaries/ru.json';

/** Тексты видеопанели (`storyUi.plan` + `storyUi.render`); по умолчанию — русские. */
export type StoryPlanStrings = {
  plan: typeof ru.storyUi.plan;
  render: typeof ru.storyUi.render;
};
const RU_PLAN: StoryPlanStrings = {
  plan: ru.storyUi.plan,
  render: ru.storyUi.render,
};
const fp = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{\{(\w+)\}\}/g, (m, k: string) =>
    k in vars ? String(vars[k]) : m
  );

export const STORY_PRONUNCIATION_MAX = 5;
export const STORY_PRONUNCIATION_CHARS = 40;
/** Сервер принимает WAV PCM16 моно до 1 МБ: 20 с × 22,05 кГц ≈ 0,88 МБ. */
export const STORY_PREAMBLE_WAV_RATE = 22050;
export const STORY_PREAMBLE_MIN_SEC = 1;
export const STORY_PREAMBLE_MAX_SEC = 20;
/**
 * ST2-U-12: файл вступления декодируется в браузере целиком (Float32 PCM),
 * хотя нужны только первые 20 с — 10 мин стерео 48 кГц ≈ 230 МБ памяти,
 * что роняет WebView Telegram. Файл больше 15 МБ отклоняется ДО чтения:
 * 20 с даже несжатого WAV 48 кГц стерео 16 бит — ≈3,8 МБ, MP3/M4A — сотни КБ.
 */
export const STORY_PREAMBLE_FILE_MAX_BYTES = 15 * 1024 * 1024;
/** Текст отказа для слишком большого файла вступления (или `null`). */
export function preambleFileError(
  file: { size: number },
  s: StoryPlanStrings = RU_PLAN
): string | null {
  if (file.size <= STORY_PREAMBLE_FILE_MAX_BYTES) return null;
  return fp(s.plan.fileTooBig, { max: STORY_PREAMBLE_MAX_SEC });
}

export type PronunciationRow = { written: string; spoken: string };
export type StoryVideoChoice = {
  preambleText: string;
  preambleSource: 'synth' | 'recorded';
  recordingId?: string | null;
  outroText?: string;
  pronunciations?: PronunciationRow[];
  profileId?: string;
  voiceConsent?: boolean;
  voiceConsentVersion?: string;
  /** Образ рассказчика из профиля в кадре вступления (только с голосом профиля). */
  useNarratorImage?: boolean;
};
export type StoryVideoBody = {
  preambleText: string;
  preambleSource?: 'recorded';
  recordingId?: string;
  outroText?: string;
  pronunciations?: PronunciationRow[];
  narratorManifestId?: string;
  voiceConsentVersion?: string;
  voiceConsentAccepted?: boolean;
  useNarratorImage?: true;
};
export type StoryQuoteSegment = {
  kind: 'intro' | 'gift_note' | 'main' | 'outro';
  position?: 'beginning' | 'end';
  source: 'synth' | 'recorded' | 'gift' | 'parent';
  text: string;
  ttsText: string;
  pronunciations: string[];
  includes?: string[];
  visual: 'cover' | 'base' | 'photo' | 'narrator';
  state: 'reuse' | 'synthesize' | 'blocked';
  seconds: number | null;
  characters: number;
};
export type StoryVideoQuote = {
  sideEffects: 'none';
  configHash: string;
  existingRender: { id: string; status: string } | null;
  baseRevision: string;
  baseHash: string;
  voice: { label: string; profile: 'nova' | 'parent'; cloning: false };
  segments: StoryQuoteSegment[];
  narrator?: {
    kind: 'original' | 'variant';
    lookId: string | null;
    asset: string;
    style: string;
    assetHash: string;
    consentVersion: string | null;
  } | null;
  layout: { durationSeconds: number } | null;
  /** true — часть длительностей ещё не синтезирована и оценена по тексту. */
  layoutEstimated?: boolean;
  warnings?: string[];
  reserveMicroUsd: number;
  /** Оценка проверки речи Soniox итогового MP4 (сервер). */
  qaEstimateMicroUsd?: number | null;
  reservedMicroUsd: number;
  budgetMicroUsd: number;
  remainingMicroUsd: number;
  fits: boolean;
  blockers: string[];
  hints: { code: string; message: string }[];
};

const clean = (v: string) => v.normalize('NFC').replace(/\s+/g, ' ').trim();
/** Та же проверка, что на сервере; пустые строки формы пропускаются. */
export function cleanPronunciations(
  rows: readonly PronunciationRow[],
  str: StoryPlanStrings = RU_PLAN
): {
  list: PronunciationRow[];
  error: string | null;
} {
  const t = str.plan;
  const list = rows
    .map((r) => ({ written: clean(r.written), spoken: clean(r.spoken) }))
    .filter((r) => r.written || r.spoken);
  if (list.length > STORY_PRONUNCIATION_MAX)
    return {
      list: [],
      error: fp(t.pronMax, { max: STORY_PRONUNCIATION_MAX }),
    };
  const seen = new Set<string>();
  for (const r of list) {
    if (
      !r.written ||
      !r.spoken ||
      r.written.length > STORY_PRONUNCIATION_CHARS ||
      r.spoken.length > STORY_PRONUNCIATION_CHARS
    )
      return {
        list: [],
        error: fp(t.pronLength, { max: STORY_PRONUNCIATION_CHARS }),
      };
    if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N} '’ʼ.-]*$/u.test(r.written))
      return { list: [], error: t.pronWritten };
    if (!/^[\p{L}\p{M} '’ʼ+-]+$/u.test(r.spoken))
      return {
        list: [],
        error: t.pronSpoken,
      };
    // Как на сервере: одно слово (пересказ написания), не новая фраза.
    if (/\s/u.test(r.spoken))
      return {
        list: [],
        error: t.pronOneWord,
      };
    const key = r.written.toLocaleLowerCase();
    if (seen.has(key)) return { list: [], error: t.pronOnce };
    seen.add(key);
  }
  return { list, error: null };
}
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Предпросмотр текста для синтеза: только целые слова, без учёта регистра. */
export function applyPronunciations(
  text: string,
  list: readonly PronunciationRow[]
): string {
  if (!list.length) return text;
  const sorted = [...list].sort((a, b) => b.written.length - a.written.length);
  const map = new Map(sorted.map((p) => [p.written.toLocaleLowerCase(), p]));
  return text.replace(
    new RegExp(
      `(?<![\\p{L}\\p{N}])(?:${sorted.map((p) => escapeRx(p.written)).join('|')})(?![\\p{L}\\p{N}])`,
      'giu'
    ),
    (m) => map.get(m.toLocaleLowerCase())?.spoken ?? m
  );
}

/** Тело `POST /story-gifts/:id/video` и `/video/quote`: только известные поля. */
export function storyVideoRequest(choice: StoryVideoChoice): StoryVideoBody {
  const pron = cleanPronunciations(choice.pronunciations ?? []).list;
  const outro = choice.outroText?.trim();
  return {
    preambleText: choice.preambleText,
    ...(choice.preambleSource === 'recorded'
      ? {
          preambleSource: 'recorded' as const,
          ...(choice.recordingId ? { recordingId: choice.recordingId } : {}),
        }
      : {}),
    ...(outro ? { outroText: outro } : {}),
    ...(pron.length ? { pronunciations: pron } : {}),
    ...(choice.profileId
      ? {
          narratorManifestId: choice.profileId,
          voiceConsentVersion: choice.voiceConsentVersion,
          voiceConsentAccepted: !!choice.voiceConsent,
          ...(choice.useNarratorImage
            ? { useNarratorImage: true as const }
            : {}),
        }
      : {}),
  };
}

export const SEGMENT_LABEL: Record<StoryQuoteSegment['kind'], string> = {
  intro: 'Вступление',
  gift_note: 'Реплика о подарке',
  main: 'Сказка',
  outro: 'Завершение',
};
export const SOURCE_LABEL: Record<StoryQuoteSegment['source'], string> = {
  synth: 'синтез',
  recorded: 'ваша запись',
  gift: 'проверенная запись Nova',
  parent: 'голос из профиля',
};
export const STATE_LABEL: Record<StoryQuoteSegment['state'], string> = {
  reuse: 'переиспользуется',
  synthesize: 'будет синтезирован',
  blocked: 'требует проверки',
};
const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`;
const SEG_KEY = {
  intro: 'segIntro',
  gift_note: 'segGiftNote',
  main: 'segMain',
  outro: 'segOutro',
} as const;
const SRC_KEY = {
  synth: 'srcSynth',
  recorded: 'srcRecorded',
  gift: 'srcGift',
  parent: 'srcParent',
} as const;
const STATE_KEY = {
  reuse: 'stateReuse',
  synthesize: 'stateSynthesize',
  blocked: 'stateBlocked',
} as const;
export function storyQuoteRows(
  q: StoryVideoQuote,
  str: StoryPlanStrings = RU_PLAN
) {
  const t = str.plan;
  return q.segments.map((s) => ({
    label: `${t[SEG_KEY[s.kind]] ?? SEGMENT_LABEL[s.kind]}${s.position ? (s.position === 'beginning' ? t.posBeginning : t.posEnd) : ''}`,
    source: t[SRC_KEY[s.source]] ?? SOURCE_LABEL[s.source],
    state: t[STATE_KEY[s.state]] ?? STATE_LABEL[s.state],
    text: s.text,
    /** Показывается только когда произношение изменило текст для синтеза. */
    spoken: s.ttsText !== s.text ? s.ttsText : null,
    seconds: s.seconds,
    note: s.includes?.includes('gift_note')
      ? t.noteInRecording
      : s.visual === 'photo'
        ? t.notePhoto
        : s.visual === 'narrator'
          ? t.noteNarrator
          : null,
  }));
}
/**
 * Живая версия той же конфигурации. FAILED/DELETED — не «уже собрана»:
 * сборка запускает новую попытку (готовая речь из кэша бесплатно, но
 * тратится суточный слот и резерв сборки) — F1.
 */
export function liveExistingRender(
  q: Pick<StoryVideoQuote, 'existingRender'>
): { id: string; status: string } | null {
  const r = q.existingRender;
  return r && !['FAILED', 'DELETED'].includes(r.status) ? r : null;
}
/**
 * `member` (ST3-U-03): не-владельцу — без сумм резерва и остатка бюджета
 * провайдера; его цена — строка `charge` в кредитах.
 */
export function storyQuoteSummary(
  q: StoryVideoQuote,
  str: StoryPlanStrings = RU_PLAN,
  member = false
): string {
  const t = str.plan;
  const existing = liveExistingRender(q);
  if (existing)
    return existing.status === 'READY'
      ? t.existsReady
      : fp(t.existsRunning, {
          status: renderStatusLabel(existing.status, str),
        });
  const reuse = q.segments.filter((s) => s.state === 'reuse').length;
  const fresh = q.segments.filter((s) => s.state === 'synthesize').length;
  const length = q.layout
    ? fp(t.length, {
        approx: q.layoutEstimated ? '≈ ' : '',
        n: q.layout.durationSeconds.toFixed(1),
      })
    : '';
  const parent = q.voice.profile === 'parent' ? t.parentNoClone : '';
  return member
    ? fp(t.summaryMember, { reuse, fresh, length, parent })
    : fp(t.summary, {
        reuse,
        fresh,
        length,
        reserve: usd(q.reserveMicroUsd),
        remaining: usd(q.remainingMicroUsd),
        parent,
      });
}

/** Русские подписи статусов сборки (S3‑12): внутренние коды человеку не показываются. */
export const RENDER_STATUS_LABEL: Record<string, string> = {
  PREPARING: 'подготовка речи',
  PENDING: 'собирается',
  READY: 'готово',
  UNKNOWN: 'требует проверки оператора',
  FAILED: 'ошибка',
  DELETED: 'удалено',
};
export function renderStatusLabel(
  status: string,
  str: StoryPlanStrings = RU_PLAN
): string {
  return (str.render as Record<string, string>)[status] ?? str.render.other;
}

/**
 * Кнопка сборки (S2‑3): только по свежей смете без препятствий и в
 * пределах бюджета; резерв виден на самой кнопке. Свежесть сметы
 * (совпадение ввода) проверяет вызывающий: устаревшая смета = `null`.
 */
export function storyBuildGate(
  quote: StoryVideoQuote | null,
  withProfile: boolean,
  str: StoryPlanStrings = RU_PLAN,
  member = false
): { ok: boolean; label: string; reason: string | null } {
  const t = str.plan;
  const base = withProfile ? t.buildProfile : t.buildNova;
  if (!quote)
    return {
      ok: false,
      label: base,
      reason: member ? t.needQuoteMember : t.needQuote,
    };
  if (quote.blockers.length)
    return { ok: false, label: base, reason: t.hasBlockers };
  if (!quote.fits)
    return {
      ok: false,
      label: base,
      reason: member
        ? t.overBudgetMember
        : fp(t.overBudget, {
            reserve: usd(quote.reserveMicroUsd),
            remaining: usd(quote.remainingMicroUsd),
          }),
    };
  const existing = liveExistingRender(quote);
  if (existing)
    return {
      ok: true,
      label: existing.status === 'READY' ? t.openReady : t.openRunning,
      reason: null,
    };
  return {
    ok: true,
    // ST3-U-03: не-владельцу — без резерва провайдера (цена — в кредитах).
    label: member
      ? base
      : fp(t.withReserve, { label: base, usd: usd(quote.reserveMicroUsd) }),
    reason: null,
  };
}

/** Запись микрофона/файл → канонический WAV для сервера (моно, 22,05 кГц, ≤ 20 с). */
export function storyPreambleWav(audio: DecodedAudioLike): {
  wav: ArrayBuffer;
  seconds: number;
  trimmed: boolean;
  tooShort: boolean;
} {
  const rate = audio.sampleRate;
  const max = Math.floor(STORY_PREAMBLE_MAX_SEC * rate);
  const channels: Float32Array[] = [];
  let length = 0;
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const data = audio.getChannelData(c);
    length = Math.max(length, data.length);
    channels.push(data.length > max ? data.subarray(0, max) : data);
  }
  const pcm = resampleLinear(
    downmixToMono(channels),
    rate,
    STORY_PREAMBLE_WAV_RATE
  );
  const seconds = pcm.length / STORY_PREAMBLE_WAV_RATE;
  return {
    wav: encodeWavPcm16(pcm, STORY_PREAMBLE_WAV_RATE),
    seconds,
    trimmed: length > max + rate * 0.5,
    tooShort: seconds < STORY_PREAMBLE_MIN_SEC,
  };
}
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
