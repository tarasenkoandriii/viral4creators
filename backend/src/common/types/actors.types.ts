/**
 * Пилот говорящего AI-аватара (Hedra Character-3 + Resemble) —
 * doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md §3.4, этап 72.
 *
 * Независимое поле `Session.data.avatarVideo`, не расширение
 * `GeneratedVideo` — намеренно (§3.4 документа): отдельная ветка
 * пайплайна не должна иметь возможности случайно задеть уже
 * протестированный Veo-путь.
 *
 * `GenerationStatus` переиспользуется без изменений — тот же смысл
 * (pending/processing/complete/failed), что и у Veo (§1.1 документа).
 */

import { GenerationError, GenerationStatus } from './generation.types';
import { SubtitleTheme } from '../subtitles';

/** Пока единственный движок пилота; задел под 'sync-labs' описан в §3.1 документа как будущая, не эта задача. */
export type AvatarProvider = 'hedra';

export interface AvatarVideo {
  status: GenerationStatus;
  provider: AvatarProvider;
  providerJobId: string | null;

  /**
   * Индекс персонажа в `session.brandManifestSnapshot.characters`, с
   * которым запущен рендер — не `BrandCharacter.id`: снимок сессии
   * (`BrandCharacterSnapshot`, common/types/brand-manifest.types.ts)
   * не гарантирует непустой `sourceCharacterId` (может быть добавлен
   * ad hoc для сессии), поэтому ссылка — по позиции в уже
   * зафиксированном списке, тем же приёмом, что `CastReplacement`
   * (casting.types.ts) хранит `brandCharacterId`/`label` отдельно,
   * а не как обязательный внешний ключ.
   */
  characterIndex: number;
  /** `BrandCharacterSnapshot.sourceCharacterId` на момент запуска — информационно, может быть null. */
  sourceCharacterId: string | null;
  /** `BrandCharacterSnapshot.label` на момент запуска — чтобы показать оператору, кто это, без повторного похода в манифест. */
  characterLabel: string;
  /** `BrandCharacterSnapshot.photoUrl` на момент запуска — переданный Hedra `start_image`. */
  photoUrl: string;
  /** Что ушло в поле `prompt` запроса к Hedra (§3.2, шаг 3). */
  prompt: string;

  /** Blob-путь синтезированной Resemble озвучки (`sessions/:id/avatar-voiceover.mp3`). */
  voiceoverPathname: string;
  /**
   * Сырой результат Hedra после переноса в наш Blob (`sessions/:id/avatar-raw.mp4`)
   * — ДО прожига субтитров, тот же смысл, что `GeneratedVideo.renderedUrl`
   * у Veo-пути (`postprod.service.ts`): исходник остаётся доступным и как
   * страховка, и как источник для второго прохода ffmpeg с субтитрами.
   */
  renderedUrl: string | null;
  /**
   * Итоговая ссылка на скачивание — совпадает с `renderedUrl`, если
   * субтитры не заказаны (чекбокс выключен) или прожиг не удался
   * (деградация, а не поломка); иначе — отдельный файл
   * `sessions/:id/avatar.mp4` с вшитыми субтитрами.
   */
  downloadUrl: string | null;

  initiatedAt: Date;
  completedAt: Date | null;

  /**
   * Субтитры (§3.2, шаг 6) — явный чекбокс на запуске (`GenerateAvatarRequestDto.subtitles`),
   * выключен по умолчанию (не всем роликам они нужны — тот же принцип
   * умолчания, что у `SubtitlesMode` брендового пайплайна, `common/subtitles.ts`).
   * Прожигаются ВТОРЫМ, отдельным проходом ffmpeg ПОСЛЕ Hedra (не тем же
   * проходом, что у Veo — там кроп/голос/субтитры для уже существующего
   * файла, здесь Hedra сама создаёт видео из фото+звука, субтитры можно
   * наложить только когда файл уже есть): `pending` — чекбокс включён,
   * `.srt` собран из тайминга Resemble (`common/voiceover-script.ts`
   * `cueTimings`), задача ffmpeg либо ещё не отправлена (пока не готов
   * Hedra), либо отправлена и выполняется (`subtitleJobId` задан);
   * `done` — прожжено, `downloadUrl` указывает на файл с субтитрами;
   * `failed` — чекбокс включён, но собрать/прожечь не удалось (текст без
   * тайминга, ffmpeg не настроен, сбой задачи) — ролик всё равно
   * доставляется, просто без субтитров; `skipped` — чекбокс выключен.
   */
  subtitleStatus: 'skipped' | 'pending' | 'done' | 'failed';
  /** Тема оформления — из снимка бренда (`BrandManifestSnapshot.subtitleTheme`) на момент запуска, либо `DEFAULT_SUBTITLE_THEME`. Значима только когда `subtitleStatus !== 'skipped'`. */
  subtitleTheme: SubtitleTheme;
  /** Blob-путь собранного `.srt` (`sessions/:id/avatar-subtitles.srt`) — `null`, пока не собран или не заказан. */
  subtitlePathname: string | null;
  /** Публичная ссылка на тот же `.srt` — вход `subs` для второго прохода ffmpeg. */
  subtitleUrl: string | null;
  /** Причина `subtitleStatus: 'failed'` — `null` в остальных случаях. */
  subtitleError: string | null;
  /** Id задачи ffmpeg-прожига субтитров (`FfmpegApiService`) — `null`, пока не отправлена. */
  subtitleJobId: string | null;
  /** Когда задача ffmpeg-прожига отправлена — точка отсчёта своего дедлайна (`AVATAR_SUBTITLE_DEADLINE_MS`), отдельного от дедлайна самой Hedra. */
  subtitleJobStartedAt: Date | null;

  /** Оценка расхода на рендер Hedra (§4.2) — по прайсу `hedra-character-3`, не точный счёт провайдера. */
  costMicroUsd: number | null;

  error: GenerationError | null;
}
