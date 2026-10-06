/**
 * tutorial-manifest.ts — монтажный manifest ролика обучалки
 * (doc/TUTORIAL-POSTPROD-TEMPO-SPEC.md, «Монтажный план», 06.10.2026).
 *
 * Чистый модуль: типы, разбор, ключ идемпотентности и перевод manifest
 * в кадры `planSlideshow`/подписей/предпросмотра. Сеть, Blob и база —
 * у вызывающих (сценарный раннер, одобрение обучалки клиента, сервис
 * версий в `postprod/`).
 *
 * ## Один frameId на картинку, реплику и подпись
 *
 * Кадр manifest несёт ВСЁ, что про него знает сборка: снимок, исходную
 * длительность, дорожку реплики с измеренной длиной и происхождением,
 * текст подписи, время чтения и указатель. Предпросмотр в браузере и
 * платная сборка строятся из одного и того же manifest и одних и тех же
 * `seconds[]` (`planTempo`), поэтому экспорт совпадает с предпросмотром
 * по построению, а не по договорённости.
 *
 * ## Где лежат исходники
 *
 * Не под транзитным `tutorial-video-frames/` — тот убирается сразу после
 * сборки. Сценарный путь копирует кадры и дорожки под
 * `tutorial-video-sources/<assetId>/` (свои снимки продукта, без чужих
 * данных); обучалка клиента ссылается на кадры ЧЕРНОВИКА — это снимки
 * кабинета заказчика со своим сроком хранения (`draft-retention.ts`), и
 * постоянная копия вывела бы их из-под этого срока. Её дорожки озвучки —
 * под `tutorial-video-sources/<assetId>/voice/`. Всё под префиксом
 * удаляется вместе с роликом; метла сирот знает префикс
 * (`common/orphan-sweep.ts`).
 */

import { createHash } from 'crypto';
import {
  frameSpansSeconds,
  slideshowFps,
  SLIDESHOW_MOTIONS,
  SlideshowFrame,
  SlideshowMotion,
} from './tutorial-video-assembly';
import { CaptionFrame } from './tutorial-captions';
import { TempoFrameInput, TempoPlan } from './tutorial-tempo';

/** Меняется при несовместимой смене формата: старые manifest тогда
 *  явно non-editable, а не «как-нибудь разберутся». */
export const TUTORIAL_MANIFEST_VERSION = 1;

/** Постоянный (не транзитный) префикс редактируемых исходников. */
export const TUTORIAL_SOURCES_PREFIX = 'tutorial-video-sources/';

export function tutorialSourcesPrefix(assetId: string): string {
  return `${TUTORIAL_SOURCES_PREFIX}${assetId}/`;
}

export function sourceFramePathname(
  assetId: string,
  stepIndex: number,
): string {
  return `${tutorialSourcesPrefix(assetId)}frames/${stepIndex}.png`;
}

/** Дорожка кадра: номер шага, хеш текста и длина в имени — по имени
 *  видно, что за файл, и дорожку с тем же текстом можно переиспользовать
 *  между сборками одного черновика, не платя за синтез повторно. */
export function sourceVoicePathname(
  assetId: string,
  stepIndex: number,
  textSha: string,
  trackMs: number | null,
): string {
  const stamp = trackMs === null ? 'x' : String(Math.round(trackMs));
  return `${tutorialSourcesPrefix(assetId)}voice/${stepIndex}-${textSha.slice(0, 16)}-${stamp}.mp3`;
}

/** `.ass` версии — под префиксом исходников: удаляется вместе с ними. */
export function versionCaptionsPathname(
  assetId: string,
  versionId: string,
): string {
  return `${tutorialSourcesPrefix(assetId)}captions/${versionId}.ass`;
}

/**
 * Файлы версий — под `tutorial-videos/`: публикация
 * (`publication.service.ts`) принимает только файлы под этим префиксом,
 * а активная версия становится `blobUrl` ролика. Своя папка `versions/`
 * с владельцем в пути — метла сирот подбирает файлы ролика, которого
 * больше нет.
 */
export const TUTORIAL_VERSIONS_PREFIX = 'tutorial-videos/versions/';

export function tutorialVersionPathname(
  assetId: string,
  versionId: string,
): string {
  return `${TUTORIAL_VERSIONS_PREFIX}${assetId}/${versionId}.mp4`;
}

export function textSha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface ManifestSpeech {
  url: string;
  pathname: string | null;
  /** Измеренная длина mp3, секунды; `null` — не измерилась. */
  seconds: number | null;
  /** Ровно тот текст, что ушёл в синтез (он же — подпись кадра). */
  text: string;
  provenance: {
    provider: string;
    voiceId: string | null;
    locale: string;
    textSha: string;
  };
}

export interface ManifestFrame {
  /** Устойчивый id кадра: картинка, реплика и подпись — одно целое. */
  frameId: string;
  stepIndex: number;
  image: { url: string; pathname: string | null };
  /** Длительность кадра в ИСХОДНОЙ сборке, секунды. */
  baseSeconds: number;
  speech: ManifestSpeech | null;
  caption: string | null;
  /** Минимальное время чтения подписи (`captionReadingSeconds`). */
  readingSeconds: number | null;
  pointer: { x: number; y: number } | null;
}

export type ManifestOwner =
  | { kind: 'client-site'; draftId: string; userId: string }
  | { kind: 'scenario'; scenarioId: string; subjectKey: string };

export interface TutorialTimelineManifest {
  manifestVersion: number;
  sourceAssetId: string;
  owner: ManifestOwner;
  /** Отпечаток содержимого исходника (кадры, дорожки, длительности). */
  sourceHash: string;
  locale: string;
  theme: string | null;
  fps: number;
  /** Режим движения исходной сборки. */
  motion: SlideshowMotion;
  /** Подписи рисуются (текст — `caption` кадров). */
  captions: boolean;
  /**
   * Как озвучен исходник: `per-frame` — покадровые дорожки (темп
   * безопасен), `none` — немой, `whole` — одна дорожка на весь ролик
   * (вариант А): реплики к кадрам не привязаны, темп недоступен.
   */
  narration: 'per-frame' | 'none' | 'whole';
  /**
   * Где лежат кадры: `sources` — постоянная копия, `draft-frames` — кадры
   * черновика клиента (со сроком хранения черновика), `transit` — ещё
   * транзит сборки (сценарный путь до `complete`).
   */
  storage: 'sources' | 'draft-frames' | 'transit';
  /** Озвучку заказывали, но её не было — причина для интерфейса. */
  voiceSkipped?: string | null;
  frames: ManifestFrame[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Разбор колонки `tempoManifest`. Строка БД — чужой ввод (старые
 * форматы, ручная правка), поэтому всё проверяется; негодное —
 * `null`, то есть «темп недоступен», а не исключение.
 */
export function parseTutorialManifest(
  raw: unknown,
): TutorialTimelineManifest | null {
  if (!isObj(raw)) return null;
  if (raw.manifestVersion !== TUTORIAL_MANIFEST_VERSION) return null;
  if (typeof raw.sourceAssetId !== 'string') return null;
  if (typeof raw.sourceHash !== 'string') return null;
  if (typeof raw.locale !== 'string') return null;
  if (
    typeof raw.motion !== 'string' ||
    !(SLIDESHOW_MOTIONS as readonly string[]).includes(raw.motion)
  ) {
    return null;
  }
  if (!['per-frame', 'none', 'whole'].includes(String(raw.narration))) {
    return null;
  }
  if (!['sources', 'draft-frames', 'transit'].includes(String(raw.storage))) {
    return null;
  }
  const owner = raw.owner;
  if (!isObj(owner)) return null;
  if (
    !(
      (owner.kind === 'client-site' &&
        typeof owner.draftId === 'string' &&
        typeof owner.userId === 'string') ||
      (owner.kind === 'scenario' &&
        typeof owner.scenarioId === 'string' &&
        typeof owner.subjectKey === 'string')
    )
  ) {
    return null;
  }
  if (!Array.isArray(raw.frames) || raw.frames.length === 0) return null;
  const frames: ManifestFrame[] = [];
  for (const f of raw.frames) {
    if (!isObj(f) || !isObj(f.image)) return null;
    if (typeof f.frameId !== 'string' || !Number.isInteger(f.stepIndex)) {
      return null;
    }
    const base = finiteOrNull(f.baseSeconds);
    if (base === null || base <= 0 || typeof f.image.url !== 'string') {
      return null;
    }
    let speech: ManifestSpeech | null = null;
    if (f.speech !== null && f.speech !== undefined) {
      const s = f.speech;
      if (
        !isObj(s) ||
        typeof s.url !== 'string' ||
        typeof s.text !== 'string' ||
        !isObj(s.provenance)
      ) {
        return null;
      }
      const p = s.provenance;
      speech = {
        url: s.url,
        pathname: typeof s.pathname === 'string' ? s.pathname : null,
        seconds: finiteOrNull(s.seconds),
        text: s.text,
        provenance: {
          provider: String(p.provider ?? ''),
          voiceId: typeof p.voiceId === 'string' ? p.voiceId : null,
          locale: String(p.locale ?? raw.locale),
          textSha: String(p.textSha ?? ''),
        },
      };
    }
    const pointer =
      isObj(f.pointer) &&
      finiteOrNull(f.pointer.x) !== null &&
      finiteOrNull(f.pointer.y) !== null
        ? { x: f.pointer.x as number, y: f.pointer.y as number }
        : null;
    frames.push({
      frameId: f.frameId,
      stepIndex: f.stepIndex as number,
      image: {
        url: f.image.url,
        pathname:
          typeof f.image.pathname === 'string' ? f.image.pathname : null,
      },
      baseSeconds: base,
      speech,
      caption: typeof f.caption === 'string' && f.caption ? f.caption : null,
      readingSeconds: finiteOrNull(f.readingSeconds),
      pointer,
    });
  }
  if (frames.some((f, i) => i > 0 && f.stepIndex <= frames[i - 1].stepIndex)) {
    return null;
  }
  return {
    manifestVersion: TUTORIAL_MANIFEST_VERSION,
    sourceAssetId: raw.sourceAssetId,
    owner: owner as unknown as ManifestOwner,
    sourceHash: raw.sourceHash,
    locale: raw.locale,
    theme: typeof raw.theme === 'string' ? raw.theme : null,
    fps: finiteOrNull(raw.fps) ?? 0,
    motion: raw.motion as SlideshowMotion,
    captions: raw.captions === true,
    narration: raw.narration as TutorialTimelineManifest['narration'],
    storage: raw.storage as TutorialTimelineManifest['storage'],
    voiceSkipped:
      typeof raw.voiceSkipped === 'string' ? raw.voiceSkipped : null,
    frames,
  };
}

/**
 * Отпечаток содержимого исходника — то, от чего зависит любая версия:
 * порядок и номера кадров, исходные длительности, тексты и длины реплик,
 * подписи, указатель и `contentHash` строки ролика (байты кадров).
 * Ссылки в отпечаток НЕ входят: перенос исходников из транзита в
 * постоянный префикс не меняет содержимого и не должен плодить версии.
 */
export function manifestSourceHash(
  frames: readonly ManifestFrame[],
  assetContentHash: string | null,
): string {
  const h = createHash('sha256');
  h.update(String(assetContentHash ?? ''));
  for (const f of frames) {
    h.update('\u0000');
    h.update(
      JSON.stringify([
        f.frameId,
        f.stepIndex,
        f.baseSeconds,
        f.speech
          ? [f.speech.seconds, f.speech.provenance.textSha, f.speech.text]
          : null,
        f.caption,
        f.readingSeconds,
        f.pointer,
      ]),
    );
  }
  return h.digest('hex');
}

/**
 * Новый manifest: версия формата, частота кадров плана и отпечаток
 * содержимого проставляются здесь, а не каждым из двух писателей.
 */
export function buildTutorialManifest(
  input: Omit<
    TutorialTimelineManifest,
    'manifestVersion' | 'fps' | 'sourceHash'
  > & { assetContentHash: string | null },
): TutorialTimelineManifest {
  const { assetContentHash, ...rest } = input;
  return {
    ...rest,
    manifestVersion: TUTORIAL_MANIFEST_VERSION,
    fps: slideshowFps(),
    sourceHash: manifestSourceHash(rest.frames, assetContentHash),
  };
}

/** Вход планировщика темпа — из manifest, всегда из ИСХОДНЫХ длительностей. */
export function tempoInputs(m: TutorialTimelineManifest): TempoFrameInput[] {
  return m.frames.map((f) => ({
    baseSeconds: f.baseSeconds,
    speech: f.speech ? { seconds: f.speech.seconds } : null,
    readingSeconds: f.caption ? f.readingSeconds : null,
  }));
}

/**
 * Ключ идемпотентности версии: sourceHash + manifestVersion +
 * нормализованный темп + переходы (и подписи — они меняют картинку).
 */
export function tempoIdempotencyKey(
  m: TutorialTimelineManifest,
  factor: number,
  motion: SlideshowMotion,
): string {
  return createHash('sha256')
    .update(
      [
        m.sourceHash,
        `v${m.manifestVersion}`,
        `k${factor.toFixed(2)}`,
        `m:${motion}`,
        `c:${m.captions ? 1 : 0}`,
      ].join('\u0000'),
    )
    .digest('hex');
}

/** Ключ «исходной» версии (сохранённый файл ролика до первой версии темпа). */
export const SOURCE_VERSION_KEY = 'source';

export type ManifestUnavailableReason =
  /** Ролик собран до manifest — пересоберите из черновика. */
  | 'no-manifest'
  /** Одна дорожка на весь ролик: реплики к кадрам не привязаны. */
  | 'whole-track'
  /** Исходники ещё не перенесены из транзита (сборка не завершена). */
  | 'sources-pending'
  /** Ролик не собран (нечего менять). */
  | 'not-complete'
  /** Кадры черновика клиента стёрты по сроку хранения (`draft-retention`). */
  | 'frames-purged';

export function manifestEditability(
  asset: { assemblyStatus: string; blobUrl: string | null },
  m: TutorialTimelineManifest | null,
): { editable: true } | { editable: false; reason: ManifestUnavailableReason } {
  if (asset.assemblyStatus !== 'complete' || !asset.blobUrl) {
    return { editable: false, reason: 'not-complete' };
  }
  if (!m) return { editable: false, reason: 'no-manifest' };
  if (m.narration === 'whole')
    return { editable: false, reason: 'whole-track' };
  if (m.storage === 'transit') {
    return { editable: false, reason: 'sources-pending' };
  }
  return { editable: true };
}

/** Кадры `planSlideshow` по manifest и новым секундам. */
export function manifestSlides(
  m: TutorialTimelineManifest,
  seconds: readonly number[],
): SlideshowFrame[] {
  return m.frames.map((f, i) => ({
    stepIndex: f.stepIndex,
    url: f.image.url,
    seconds: seconds[i],
    ...(f.speech ? { audioUrl: f.speech.url } : {}),
    ...(f.pointer ? { pointer: f.pointer } : {}),
  }));
}

/** Кадры подписей по тем же секундам (пусто, если подписи выключены). */
export function manifestCaptionFrames(
  m: TutorialTimelineManifest,
  seconds: readonly number[],
): CaptionFrame[] {
  return m.frames.map((f, i) => ({
    seconds: seconds[i],
    narration: m.captions ? f.caption : null,
  }));
}

/** Кадр предпросмотра в браузере — тот же manifest, та же сетка. */
export interface PreviewFrame {
  frameId: string;
  stepIndex: number;
  imageUrl: string;
  start: number;
  end: number;
  speech: { url: string; seconds: number | null } | null;
  caption: string | null;
  pointer: { x: number; y: number } | null;
}

export interface TempoPreview {
  frames: PreviewFrame[];
  durationMs: number;
  /** Длительность перехода, секунды (0 — без переходов). */
  transitionSeconds: number;
  motion: SlideshowMotion;
}

/**
 * Предпросмотр: кадры и реплики по той же сетке, что уйдёт в сборку
 * (`frameSpansSeconds`). Реплика начинается в начале своего кадра —
 * ровно как в команде ffmpeg (сегмент звука = «от начала кадра до
 * начала следующего»).
 */
export function tempoPreview(
  m: TutorialTimelineManifest,
  plan: TempoPlan,
  requestedMotion: SlideshowMotion,
): TempoPreview {
  const spans = frameSpansSeconds(
    plan.seconds.map((s) => ({ seconds: s })),
    requestedMotion,
  );
  // Переход — разница между длиной первого кадра и началом второго:
  // ровно столько `xfade` съедает на стыке (та же сетка, без второго
  // знания о частоте кадров).
  const transitionSeconds =
    spans.length > 1
      ? Math.max(
          0,
          Math.round((plan.seconds[0] - spans[1].start) * 1000) / 1000,
        )
      : 0;
  return {
    frames: m.frames.map((f, i) => ({
      frameId: f.frameId,
      stepIndex: f.stepIndex,
      imageUrl: f.image.url,
      start: spans[i].start,
      end: spans[i].end,
      speech: f.speech
        ? { url: f.speech.url, seconds: f.speech.seconds }
        : null,
      caption: m.captions ? f.caption : null,
      pointer: f.pointer,
    })),
    durationMs: plan.durationMs,
    transitionSeconds,
    motion: plan.motion,
  };
}

/**
 * Что активации нужно знать о плане версии: длительность её файла, та
 * самая `plan.durationMs`, с которой версия собрана. Отдельным типом —
 * активация пишет строку ролика, и длительность туда попадает только
 * из плана (шов «длительность — только plan.durationMs»).
 */
export interface ActivationPlan {
  readonly durationMs: number | null;
}
