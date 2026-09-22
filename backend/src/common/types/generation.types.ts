/**
 * Generation Types
 *
 * Defines generated video structures and processing status.
 */

/**
 * Video generation status
 */
export enum GenerationStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETE = 'complete',
  FAILED = 'failed',
}

/**
 * Which Veo tier to render with.
 *
 * 'fast' maps to veo-3.1-lite-generate-preview — the cheaper, quicker tier
 * actually exposed on the Gemini Developer API today. A distinct
 * "veo-3.1-fast-generate-preview" model exists, but only on Vertex AI
 * (a separate GCP project + service account, not just an API key), so it
 * isn't wired up here. See GenerationService's VEO_MODELS map.
 */
export type VideoQuality = 'fast' | 'standard';

/**
 * Generation error details
 */
export interface GenerationError {
  /** Error code */
  code: string;

  /** Error message */
  message: string;

  /** Error timestamp */
  timestamp: Date;

  /** Whether user can retry */
  retryable: boolean;
}

/**
 * GeneratedVideo represents the newly created advertisement video
 */
export interface GeneratedVideo {
  /** Unique identifier (UUID) */
  generatedVideoId: string;

  /** Vercel Blob pathname for generated video (e.g. "sessions/{id}/generated.mp4") */
  pathname: string;

  /** Generated filename */
  fileName: string;

  /** File size in bytes (unknown until complete, optional) */
  fileSize?: number;

  /** MIME type (typically video/mp4) */
  mimeType: string;

  /** Processing status */
  status: GenerationStatus;

  /**
   * Доп. запрос владельца продукта: выбор провайдера видео-генерации
   * (§10–11 ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md) — по умолчанию `'veo'`
   * (текущее поведение) для обратной совместимости со старыми записями,
   * где поля вообще нет.
   */
  provider?: 'veo' | 'grok';

  /**
   * Только для `provider === 'grok'` — Veo по-прежнему не запрашивает
   * разрешение явно (см. ТЗ §10.1). Цена Grok зависит от разрешения
   * (§10.2 ТЗ) — 480p дешевле 1080p почти втрое.
   */
  resolution?: '480p' | '720p' | '1080p';

  /** ID генерации у xAI, для `provider === 'grok'` — отдельно от
   * `veoOperationName` (см. ниже), не переиспользует его: разные
   * провайдеры, разный формат ID, смешивать в одном поле значило бы
   * терять информацию о том, какой из двух реально там лежит. */
  grokRequestId?: string;
  /** Транспорт Grok = batch (доп. запрос владельца продукта,
   * 14.09.2026, `grok-video-transport.ts`): ID пачки xAI из одного
   * запроса и ключ этого запроса в ней (`batch_request_id`, равен
   * `generatedVideoId` базы или `${generatedVideoId}-ext-N` расширения).
   * Заполнены вместо `grokRequestId`; при продолжении цепочки пачка
   * создаётся заново — оба поля перезаписываются. */
  xaiBatchId?: string;
  xaiBatchRequestId?: string;

  /**
   * Доп. запрос владельца продукта: ролики длиннее 8 секунд через Scene
   * Extension (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §9, этап 4 плана
   * §14). Все три поля вместе или ни одного — `undefined` означает
   * обычную, однократную генерацию, как было раньше этой фичи.
   */
  /** Сколько сегментов цепочки уже готово — включая текущий, ещё не
   * дописанный (растёт по мере продолжений); статус видео остаётся
   * PROCESSING, пока `chainSegmentsDone < chainSegmentsTotal`. */
  chainSegmentsDone?: number;
  /** Сколько сегментов нужно всего — из `buildExtensionPlan()`
   * (`common/video-extension-plan.ts`), посчитано один раз при старте. */
  chainSegmentsTotal?: number;
  /** Итоговая длительность ролика в секундах, к которой идёт цепочка —
   * может быть меньше того, что изначально просил пользователь, если
   * запрос был урезан потолком провайдера/референса (см. `wasCapped`
   * в `ExtensionPlan`). */
  chainTargetDurationSeconds?: number;
  /** Длительность каждого сегмента цепочки по порядку (секунды) — из
   * `ExtensionPlan.segments`. Нужна Grok: база до 15 с нативно и одно
   * расширение переменной длины через `/v1/videos/extensions`; без
   * этого поля продолжение не знало бы, сколько секунд просить. У Veo
   * все сегменты по 8 — поле пишется для единообразия. Нет у записей
   * до 14.09.2026 — тогда считаем по 8. */
  chainSegmentSeconds?: number[];

  /**
   * Доп. запрос владельца продукта: поле «Чего избежать» (ТЗ
   * VEO-MODEL-VERSION-CHOICE-SPEC.md §1/§6, этап 5 плана §14) —
   * свободный текст, что не должно случиться в кадре. Уходит в
   * настоящий `negativePrompt`, когда авто-выбор включил Veo 3.0
   * (`common/veo-model-choice.ts`, `usesVeo30()`); иначе — best-effort
   * строкой в основной промпт (Veo 3.1, `fast`, Grok — §4.1 ТЗ).
   */
  avoidText?: string;

  /** When generation was started */
  initiatedAt: Date;

  /**
   * Picture format (spec §16). `aspectRatio` is what the user asked for;
   * `renderedAspectRatio` what Veo actually produced (natively only 16:9 /
   * 9:16); `reframePending` = a center-crop to `aspectRatio` is still
   * owed (media worker, PUBLISHING-AND-VOICEOVER-SPEC §15.5).
   */
  aspectRatio?: string;
  renderedAspectRatio?: '16:9' | '9:16';
  reframePending?: boolean;

  /**
   * Ролик заказан у провайдера БЕЗ звуковой дорожки
   * (`generate_audio: false` у Grok) — значит у файла нет потока
   * `0:a` вовсе.
   *
   * Постобработке это знать обязательно: фильтр режима `voiceover`
   * обращается к `[0:a]`, чтобы приглушить оригинал и подмешать нашу
   * дорожку, и на файле без звука ffmpeg падает («Stream specifier
   * matches no streams»), а не тихо пропускает фильтр. См.
   * `buildPostProductionCommand`.
   *
   * Отсутствие поля читается как «звук есть» — так ведут себя все
   * записи до 22.09.2026 и все товарные ролики.
   */
  silentSource?: boolean;

  /**
   * Постобработка одной задачей ffmpeg (ТЗ §15.4/§16.1, этапы 34–35):
   * обрезка кадра и/или наложение своей звуковой дорожки.
   *
   * До этапа 35 поле называлось `reframeStatus` и означало только
   * обрезку. Имя сменилось вместе со смыслом: озвучка и обрезка идут
   * ОДНОЙ задачей, и держать для неё два статуса значило бы позволить им
   * разойтись — а разошедшиеся статусы одной операции это самый дорогой
   * вид путаницы в отладке.
   *
   * `pending` — задача идёт, `complete` — `downloadUrl` указывает на
   * готовый файл, `failed` — не вышло и остаётся исходный ролик (это
   * ухудшение, а не поломка: ролик у пользователя есть), `skipped` —
   * делать было нечего или сервис не настроен.
   */
  postStatus?: 'pending' | 'complete' | 'failed' | 'skipped';
  postJobId?: string;
  /**
   * Когда задача отправлена ffmpeg (этап 52, В-2.7). По нему опрос
   * закрывает «идёт» сбоем, если ответа нет дольше дедлайна: без этого
   * незнакомый статус провайдера или потерянная задача давали вечное
   * «обрабатывается», а аудит не отпускал никогда.
   */
  postStartedAt?: Date;
  postError?: string;
  /** Путь готового файла постобработки в Blob — владелец тот же, сессия (§22). */
  postPathname?: string;
  /** Исходный ролик Veo: остаётся доступным для сравнения. */
  renderedUrl?: string;

  /**
   * Озвучка (ТЗ §15, этап 35). Синтез идёт ДО задачи ffmpeg и имеет
   * собственный исход: голос может не синтезироваться (ключа нет — это
   * штатное состояние стенда), и тогда постобработка сводится к обрезке.
   */
  voiceMode?: 'veo' | 'voiceover' | 'dub';
  voiceStatus?: 'skipped' | 'synthesized' | 'failed';
  voiceError?: string;
  /** Дорожка в нашем Blob — чужая ссылка на озвучку живёт часы. */
  voiceoverPathname?: string;
  voiceoverUrl?: string;
  /** Символы, ушедшие в счёт провайдера синтеза (§26). */
  voiceCharacters?: number;

  /**
   * Жёстко вшитые субтитры (TODO §Уровень 2.7, этап 67) — третий
   * ингредиент того же прохода ffmpeg, что кроп и голос. Та же пара
   * «режим / статус», что у voiceMode/voiceStatus: провал сборки не
   * отменяет ни кроп, ни звук — субтитры просто не накладываются.
   */
  subtitlesMode?: 'off' | 'on';
  /** `burned` — дорожка субтитров собрана и передана в задачу ffmpeg (не то же, что готовность самой задачи — см. postStatus). */
  subtitleStatus?: 'skipped' | 'burned' | 'failed';
  subtitleError?: string;
  /** `.srt` в нашем Blob — тот же приём, что у дорожки озвучки. */
  subtitlePathname?: string;
  subtitleUrl?: string;

  /**
   * What Veo received as `referenceImages` (spec §10.2/§10.3, Stage 15) —
   * empty for the legacy first-frame path. Kept so the result screen and
   * the post-generation audit (§11) can say which photos shaped the video.
   *
   * Найдено при аудите (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §20) —
   * `'text-card'` добавлен в `kind` следом за
   * `ReferenceImageSource.kind` (`common/reference-plan.ts`), тем же
   * классом ошибки, что уже несколько раз всплывал в этом проекте:
   * дублирующий, более узкий тип не обновился вместе с источником.
   */
  references?: Array<{
    index: number;
    kind: 'character' | 'scene' | 'product' | 'text-card';
    label: string;
    characterId: string | null;
  }>;

  /** When generation finished (optional) */
  completedAt?: Date;

  /** Estimated completion (if available, optional) */
  estimatedCompletionTime?: Date;

  /**
   * Public Vercel Blob URL for the generated video, set once at upload
   * time. Unlike the old S3 presigned GET URL, this doesn't expire — a
   * fixed pathname's public Blob URL is stable for as long as the blob
   * exists — so it's stored once here and returned as-is on every later
   * status poll, no re-signing needed.
   */
  downloadUrl?: string;

  /** Error details if generation failed (optional) */
  error?: GenerationError;

  /**
   * Veo long-running operation's resource name (e.g. "operations/abc123").
   * Persisted so a later, separate HTTP request (the client's status poll)
   * can resume checking progress — no server-side polling loop needed.
   */
  veoOperationName?: string;

  /** Which Veo tier this video was (or is being) rendered with */
  quality?: VideoQuality;

  /**
   * Автоэкспорт под площадки (TODO §III, «Уровень 6», п.35;
   * `doc/MULTI-FORMAT-EXPORT-SPEC.md`, этап 75) — запускается явно
   * пользователем ПОСЛЕ того, как основной ролик уже готов, не заранее:
   * так не платят за форматы, которые в итоге не понадобились (§7.7
   * документа).
   *
   * `exportJobId` — id ОДНОЙ пакетной задачи ffmpeg яруса A на ВСЕ
   * запрошенные за один вызов дешёвые форматы разом (`modules/export`,
   * `PostProductionService.startExport`/`pollExport`); яруса B здесь нет
   * — у него нет своей задачи, статус каждого варианта яруса B двигает
   * его собственная дочерняя сессия (`ExportVariant.childSessionId`).
   */
  exportJobId?: string;
  exportVariants?: ExportVariant[];
}

/**
 * Один запрошенный вариант автоэкспорта (`doc/MULTI-FORMAT-EXPORT-SPEC.md`
 * §4, этап 75).
 */
export interface ExportVariant {
  /** Формат «W:H» — тот же алфавит, что STANDARD_ASPECT_RATIOS. */
  format: string;
  /** Пресет площадки, если вариант запрошен по имени (`PLATFORM_EXPORT_PRESETS`), а не голым форматом. */
  preset?: string;
  /**
   * A — дешёвая обрезка уже готового файла (без нового рендера Veo);
   * B — второй платный рендер Veo для формата из другого семейства
   * кадра (`aspectRatioFamily`). Разные пользовательские действия с
   * разной ценой и разным риском по композиции — не один и тот же
   * чекбокс (§3 документа).
   */
  tier: 'A' | 'B';
  status: 'pending' | 'complete' | 'failed';
  /** Ярус A: имя файла ВНУТРИ пакетной задачи — сопоставляет ответ ffmpeg-сервиса с этим вариантом. */
  outputName?: string;
  /** Ярус B: дочерняя сессия второго рендера — её generatedVideo и есть источник статуса. */
  childSessionId?: string;
  /** Путь готового файла в нашем Blob — заполняется по завершении (оба яруса). */
  pathname?: string;
  url?: string;
  error?: string;
  requestedAt: string;
}
