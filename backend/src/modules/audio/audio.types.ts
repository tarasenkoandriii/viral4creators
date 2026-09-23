/**
 * Абстракция источника музыки — портирована из соседнего проекта автора
 * (`atm-travel`, `src/audio/`) и подогнана под этот репозиторий.
 *
 * Смысл ровно тот же: один интерфейс, несколько адаптеров, DI-токен,
 * который их собирает, и декларативный запрос, который решает, к кому
 * идти. Ничего из @nestjs здесь нет намеренно — этот файл чистый и
 * потому проверяемый тестами без контейнера.
 *
 * ## Модель возможностей
 *
 *  - Jamendo и Freesound — КАТАЛОГИ, умеют `search`;
 *  - Mubert — ГЕНЕРАТОР, умеет `generate`.
 *
 * ## Почему лицензия — часть типа, а не примечание
 *
 * Поздравление человек отправляет другому человеку, а сервис за это
 * берёт деньги. Значит музыка в нём используется коммерчески, и
 * «бесплатно скачать» тут ничего не решает — решает лицензия. Поэтому
 * `commercialUse`, `attributionRequired` и `requiresPaidLicense` лежат
 * в самом треке и проверяются фильтром ДО того, как трек попадёт в
 * выдачу, а не после претензии.
 */

export type AudioProviderId = 'jamendo' | 'freesound' | 'mubert';
export type AudioCapability = 'search' | 'generate';
export type AudioKind = 'music' | 'sfx' | 'ambience' | 'generative';

export interface AudioLicense {
  /** Метка провайдера: `CC0-1.0`, `CC-BY-4.0`, `mubert-royalty-free`… */
  type: string;
  commercialUse: boolean;
  attributionRequired: boolean;
  /** Готовая строка кредита; есть только когда атрибуция обязательна. */
  attributionText?: string;
  licenseUrl?: string;
  /**
   * Бесплатный тариф провайдера коммерческое использование НЕ
   * покрывает, нужна отдельная покупка. У Jamendo это норма, и без
   * купленной лицензии такой трек нам не подходит вовсе.
   */
  requiresPaidLicense?: boolean;
}

export interface NormalizedAudioTrack {
  provider: AudioProviderId;
  providerTrackId: string;
  kind: AudioKind;
  title: string;
  artist?: string;
  durationSec: number;
  bpm?: number;
  key?: string;
  mood: string[];
  genre: string[];
  tags: string[];
  /** Короткое превью для прослушивания на экране. */
  previewUrl?: string;
  /** То, что реально скачивается и уходит в ролик. */
  audioUrl: string;
  license: AudioLicense;
}

/** Декларативный запрос: что нужно, а не у кого просить. */
export interface AudioRequest {
  kind: Exclude<AudioKind, 'generative'>;
  query?: string;
  mood?: string[];
  genre?: string[];
  bpmRange?: [number, number];
  durationSec?: number;
  /** По умолчанию `true`: некоммерческие лицензии отсекаются. */
  commercialUseRequired?: boolean;
  /** `false` — треки с обязательным упоминанием автора не показываем. */
  allowAttribution?: boolean;
  /** `false` — треки, требующие покупки лицензии, отсекаются. */
  allowPaidLicense?: boolean;
  maxResults?: number;
}

export interface AudioProvider {
  readonly id: AudioProviderId;
  readonly capabilities: readonly AudioCapability[];
  /** Есть ли у провайдера ключи. Без них он молча не участвует. */
  readonly enabled: boolean;
  search?(req: AudioRequest): Promise<NormalizedAudioTrack[]>;
  generate?(req: AudioRequest): Promise<NormalizedAudioTrack>;
  /**
   * У некоторых провайдеров ссылка из выдачи — только превью, а
   * полноценный файл берётся вторым вызовом.
   */
  resolveDownloadUrl?(track: NormalizedAudioTrack): Promise<string>;
}

/** URL лицензии Creative Commons → разобранная лицензия. */
export function normalizeCcLicense(licenseUrl: string): AudioLicense {
  const url = (licenseUrl || '').toLowerCase();
  let type = 'unknown';
  if (url.includes('publicdomain') || url.includes('zero')) type = 'CC0-1.0';
  else if (url.includes('by-nc')) type = 'CC-BY-NC';
  else if (url.includes('by-sa')) type = 'CC-BY-SA-4.0';
  else if (url.includes('/by/')) type = 'CC-BY-4.0';

  // `unknown` НЕ считается коммерчески пригодной: неизвестная лицензия
  // это не «наверное можно», а «мы не знаем» — и рисковать чужим
  // поздравлением на этом основании нельзя.
  const commercialUse = !type.includes('NC') && type !== 'unknown';
  const attributionRequired = type !== 'CC0-1.0' && commercialUse;
  return { type, commercialUse, attributionRequired, licenseUrl };
}

export function bpmCenter(range?: [number, number]): number | undefined {
  return range ? Math.round((range[0] + range[1]) / 2) : undefined;
}

/** Жёсткий фильтр: подходит ли трек по лицензии и темпу. */
export function trackPassesFilter(
  t: NormalizedAudioTrack,
  req: AudioRequest,
): boolean {
  if (req.commercialUseRequired !== false && !t.license.commercialUse) {
    return false;
  }
  if (req.allowAttribution === false && t.license.attributionRequired) {
    return false;
  }
  if (req.allowPaidLicense === false && t.license.requiresPaidLicense) {
    return false;
  }
  if (req.bpmRange && t.bpm != null) {
    const [lo, hi] = req.bpmRange;
    if (t.bpm < lo || t.bpm > hi) return false;
  }
  return true;
}

/** Мягкое ранжирование: больше — лучше. */
export function scoreTrack(t: NormalizedAudioTrack, req: AudioRequest): number {
  let score = 0;
  const wanted = new Set(
    [...(req.mood ?? []), ...(req.genre ?? [])].map((s) => s.toLowerCase()),
  );
  const have = new Set(
    [...t.mood, ...t.genre, ...t.tags].map((s) => s.toLowerCase()),
  );
  for (const w of wanted) if (have.has(w)) score += 2;

  const center = bpmCenter(req.bpmRange);
  if (center != null && t.bpm != null) {
    score += Math.max(0, 5 - Math.abs(t.bpm - center) / 5);
  }
  if (req.durationSec != null) {
    score += Math.max(0, 3 - Math.abs(t.durationSec - req.durationSec) / 10);
  }
  return score;
}

/** Видимая строка кредита для трека, который её требует. */
export function buildAttribution(t: NormalizedAudioTrack): string | undefined {
  if (!t.license.attributionRequired) return undefined;
  if (t.license.attributionText) return t.license.attributionText;
  const who = t.artist ? `${t.title} — ${t.artist}` : t.title;
  return `${who} (${t.license.type}), ${t.provider}`;
}
