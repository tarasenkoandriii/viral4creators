/**
 * Правка брифа и сценария после старта сессии — чистая часть этапа C ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §3.6 (Г-3, Г-4).
 *
 * Здесь только решения, без Prisma и Nest: что считать сменой смысла
 * текста, что сбросить как несовместимое с новым регистром, можно ли
 * править сейчас и нужна ли новая версия сессии. Сервис
 * (`GreetingSessionEditService`) лишь исполняет эти решения.
 */

import { GenerationStatus } from './types/generation.types';
import type { GeneratedVideo } from './types/generation.types';
import type { GreetingBriefSnapshot } from './types/greeting.types';
import {
  REGISTER_POLICY,
  evaluateGreetingPolicy,
  registerOfBrief,
} from './greeting-policy';
import { normalizeSceneCount } from './greeting-scenes';
import { scriptLanguageOf } from './greeting-language';

/**
 * Что может пропасть при правке: четыре поля — при смене регистра,
 * `referenceImages` — фото, не скопировавшееся в новую версию сессии.
 */
export type ResettableField =
  | 'sticker'
  | 'musicTheme'
  | 'sceneCount'
  /** Обстановка ролика (§3.9), праздничная для нового регистра. */
  | 'sceneSetting'
  /** Подписи фото с праздничной атрибутикой вне праздника (аудит захода 8). */
  | 'referenceCaptions'
  | 'referenceImages';

/**
 * Поменялся ли смысл текста: повод, регистр, тон, получатель,
 * отправитель, свой текст или язык. Тогда собранный сценарий устарел —
 * иначе ролик озвучил бы поздравление с днём рождения после того, как
 * повод сменили на соболезнование.
 *
 * Провайдер и качество видео сюда не входят: описание сцены от них не
 * зависит (`buildSceneDescription`). Ведущий-образ (этап G) — входит.
 */
export function scriptInputsChanged(
  before: GreetingBriefSnapshot,
  after: GreetingBriefSnapshot,
  sessionLocale?: string | null,
): boolean {
  return (
    before.occasion !== after.occasion ||
    (before.customOccasionText ?? null) !==
      (after.customOccasionText ?? null) ||
    registerOfBrief(before) !== registerOfBrief(after) ||
    before.tone !== after.tone ||
    before.recipientName !== after.recipientName ||
    (before.senderName ?? null) !== (after.senderName ?? null) ||
    (before.personalMessage ?? null) !== (after.personalMessage ?? null) ||
    scriptLanguageOf(before, sessionLocale) !==
      scriptLanguageOf(after, sessionLocale) ||
    // Этап G (§4.8): ведущий-образ меняет описание сцены — строку «The
    // presenter is the person shown in <IMAGE_1>» и нумерацию остальных
    // изображений. Старая сцена с новым ведущим отправила бы метки не
    // туда.
    (before.presenter?.lookId ?? null) !== (after.presenter?.lookId ?? null) ||
    (before.presenter?.variant ?? null) !== (after.presenter?.variant ?? null)
  );
}

/**
 * Привести выбранное к новому регистру. Не отказ, а сброс с перечнем:
 * человек сам поменял повод, и отказать ему из-за наклейки, выбранной
 * под прежний повод, значило бы заставить его сначала найти и убрать её
 * вручную. Перечень сброшенного показывается рядом с «Сохранено» —
 * молча ничего не пропадает.
 *
 * Своя музыка не сбрасывается: политика для неё только предупреждает
 * (`ownMusicWarning`), это выбор человека.
 */
export function reconcileSelections(snapshot: GreetingBriefSnapshot): {
  snapshot: GreetingBriefSnapshot;
  resetFields: ResettableField[];
} {
  const verdict = evaluateGreetingPolicy({
    occasion: snapshot.occasion,
    occasionRegister: snapshot.occasionRegister ?? null,
    tone: snapshot.tone,
    sticker: !!snapshot.sticker,
    music: snapshot.musicTheme
      ? {
          source: snapshot.musicTheme.source ?? 'catalog',
          occasions: snapshot.musicTheme.occasions,
        }
      : null,
    sceneCount: normalizeSceneCount(snapshot.sceneCount ?? 1),
    sceneSetting: snapshot.sceneSetting ?? null,
  });
  const fields = new Set(verdict.violations.map((v) => v.field));
  const next: GreetingBriefSnapshot = { ...snapshot };
  const resetFields: ResettableField[] = [];
  if (fields.has('sticker')) {
    next.sticker = null;
    resetFields.push('sticker');
  }
  if (fields.has('music')) {
    next.musicTheme = null;
    resetFields.push('musicTheme');
  }
  if (fields.has('sceneCount')) {
    next.sceneCount = REGISTER_POLICY[verdict.register].maxScenes;
    resetFields.push('sceneCount');
  }
  if (fields.has('sceneSetting')) {
    next.sceneSetting = null;
    resetFields.push('sceneSetting');
  }
  return { snapshot: next, resetFields };
}

export type EditMode = 'in-place' | 'new-version';

/**
 * Можно ли править сейчас и как.
 *
 * - Рендер идёт (`PENDING`/`PROCESSING`) → `busy`: правка посреди
 *   рендера дала бы ролик, не совпадающий ни с прежним, ни с новым
 *   текстом, и кредит за него уже списан.
 * - Ролик готов → новая версия сессии: готовый ролик остаётся как был
 *   (ссылка на него могла уже уйти получателю), новый рендер оплачивается
 *   как обычный.
 * - Иначе — правка на месте.
 */
export function editModeOf(
  video: Pick<GeneratedVideo, 'status'> | null | undefined,
): EditMode | 'busy' {
  if (!video) return 'in-place';
  if (
    video.status === GenerationStatus.PENDING ||
    video.status === GenerationStatus.PROCESSING
  ) {
    return 'busy';
  }
  if (video.status === GenerationStatus.COMPLETE) return 'new-version';
  return 'in-place';
}

export const GREETING_EDIT_BUSY_MESSAGE =
  'Ролик сейчас собирается — дождитесь, пока он будет готов, и тогда правьте.';

/**
 * Путь блоба внутри сессии → тот же путь в другой сессии. `null` — блоб
 * не принадлежит сессии-источнику (каталожная тема, общая библиотека):
 * такой не копируется, ссылка на него переживёт удаление источника.
 */
export function rebaseSessionPath(
  pathname: string | null | undefined,
  fromSessionId: string,
  toSessionId: string,
): string | null {
  const prefix = `sessions/${fromSessionId}/`;
  if (!pathname || !pathname.startsWith(prefix)) return null;
  return `sessions/${toSessionId}/${pathname.slice(prefix.length)}`;
}

/** Тип содержимого по расширению — для копии блоба. */
export function contentTypeOf(pathname: string): string {
  const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
    case 'aac':
      return 'audio/mp4';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
      return 'audio/ogg';
    default:
      return 'application/octet-stream';
  }
}
