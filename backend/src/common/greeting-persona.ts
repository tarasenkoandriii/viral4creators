/**
 * «Я в кадре» в поздравлении и лица в референсах — чистая часть этапа G
 * ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md (§4.7, §4.8,
 * Г-6, Г-7, Г-8).
 *
 * Здесь только решения, без Prisma и Nest: годится ли образ в ведущие,
 * что из него копируется в снимок сессии, какие изображения и в каком
 * порядке уходят в видеомодель и какие фото с лицом туда не пускаются.
 * Сервисы (бриф, сценарий, видео, правка из сессии) лишь исполняют эти
 * решения — и исполняют ОДНИ и те же: метки `<IMAGE_n>` в промпте и
 * порядок `reference_images` у Grok обязаны совпадать, а две копии
 * правила порядка однажды разошлись бы.
 */

import { BadRequestException } from '@nestjs/common';
import type {
  GreetingBriefSnapshot,
  GreetingPresenterProvider,
  GreetingPresenterSnapshot,
  GreetingPresenterVariant,
} from './types/greeting.types';
import type { SceneAsset } from './types/reference.types';
import type { BrandSceneSnapshot } from './types/brand-manifest.types';
import {
  activeSessionSceneImage,
  activeSnapshotSceneImage,
} from './active-image';
import { refusalsOf } from '../modules/persona/persona-view';
import { GREETING_ERROR_CODES, greetingError } from './greeting-errors';

// ── Флаг ────────────────────────────────────────────────────────────────

/**
 * `PERSONA_ENABLED` (контракт волны: env, по умолчанию выключен). Читается
 * на каждом вызове, как и у сервиса персоны: выключение режима юристом не
 * должно ждать перезапуска.
 */
export function personaEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PERSONA_ENABLED === 'true';
}

/** CONTRACT5 п.5в: личный бренд-бук — только у поздравлений. */
export const PERSONAL_MANIFEST_GREETING_ONLY =
  'Личный бренд-бук можно выбрать только для поздравления — в товарном ролике лицо и голос автора не используются.';
/** CONTRACT5 п.5а: клон голоса персоны — в личном бренд-буке или отправителем. */
export const PERSONA_VOICE_ONLY_PERSONAL =
  'Голос вашей персоны можно выбрать только в личном бренд-буке или голосом отправителя своего поздравления.';

/** Тот же код, что отдают маршруты персоны (`GET /personas/me` → 404). */
export const PERSONA_DISABLED_CODE = 'PERSONA_DISABLED';
export const PERSONA_DISABLED_MESSAGE = 'Режим «Я в кадре» сейчас недоступен.';

/**
 * Голос персоны отправителем на Hedra без образа-ведущего (CONTRACT6
 * п.3). У Hedra голос — ВХОД липсинка: портретом без образа становится
 * первое фото сессии (`hedraPortrait`) — чужое лицо, которое заговорило
 * бы голосом автора. У Grok так не бывает: при своём голосе модель
 * снимает ролик без звука, и озвучка ложится поверх, лицо ею не движется.
 */
export const PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE =
  'Голос вашей персоны у говорящего аватара (Hedra) можно выбрать только вместе с вашим образом-ведущим — иначе вашим голосом заговорит чужое лицо. ' +
  'Выберите свой образ в брифе, ведущего Grok или другой голос.';

export function personaVoiceNeedsPresenter(
  brief: Pick<GreetingBriefSnapshot, 'resolvedPresenterProvider' | 'presenter'>,
  senderVoice: { personaVoice?: boolean } | null | undefined,
): boolean {
  return (
    senderVoice?.personaVoice === true &&
    brief.resolvedPresenterProvider === 'hedra' &&
    !brief.presenter
  );
}

// ── Ведущий-образ (§4.8) ─────────────────────────────────────────────────

/** Что нужно от строки `PersonaLook` (структурно — без клиента Prisma). */
export interface PresenterLookRow {
  id: string;
  label: string;
  status: string;
  deletedAt: Date | string | null;
  photoUrl: string | null;
  photoPathname: string | null;
  activeSketch?: {
    url: string | null;
    pathname: string | null;
    status?: string | null;
  } | null;
  persona?: { userId: string; revokedAt: Date | string | null } | null;
}

export const PRESENTER_LOOK_NOT_FOUND =
  'Образ ведущего не найден: он удалён или принадлежит не вам. Выберите другой образ в брифе.';
export const PRESENTER_LOOK_NOT_READY =
  'Образ ведущего ещё не готов — дождитесь, пока он создастся, или выберите другой.';
export const PRESENTER_SKETCH_MISSING =
  'У этого образа нет скетч-аватара. Сделайте скетч образа или выберите вариант «фото».';

/**
 * Скетч-ведущий на пути Hedra (§4.8): поддержку рисованных портретов у
 * Hedra Character-3 до выпуска не проверяли — документация говорит о
 * фотопортрете, а принимает ли модель рисунок и что делает с липсинком
 * на нём, неизвестно. Пока не проверено — честный отказ, а не рендер за
 * деньги человека наугад.
 */
export const HEDRA_SKETCH_PRESENTER_REFUSAL =
  'Говорящий аватар (Hedra) пока работает только с фото-образом: рисованные портреты не проверены. ' +
  'Выберите вариант «фото» или ведущего Grok.';

/**
 * Годится ли образ ведущим. `null` — годится; иначе текст отказа.
 * `userId` — автор брифа: образ чужой персоны читается как «не найден»,
 * не раскрывая, что такой id существует.
 */
export function presenterLookProblem(
  look: PresenterLookRow | null | undefined,
  variant: GreetingPresenterVariant,
  userId: string,
): string | null {
  if (
    !look ||
    look.deletedAt ||
    !look.persona ||
    look.persona.userId !== userId ||
    look.persona.revokedAt
  ) {
    return PRESENTER_LOOK_NOT_FOUND;
  }
  if (look.status !== 'ready' || !look.photoUrl) {
    return PRESENTER_LOOK_NOT_READY;
  }
  if (variant === 'sketch' && !look.activeSketch?.url) {
    return PRESENTER_SKETCH_MISSING;
  }
  return null;
}

/** Сочетание провайдера и варианта: `null` — можно. */
export function presenterProviderProblem(
  provider: GreetingPresenterProvider,
  variant: GreetingPresenterVariant | null | undefined,
): string | null {
  return provider === 'hedra' && variant === 'sketch'
    ? HEDRA_SKETCH_PRESENTER_REFUSAL
    : null;
}

/**
 * Копия образа в снимок сессии — URL и путь выбранного варианта. Копия,
 * а не ссылка (§4.8): удалённый потом образ не ломает уже снятый ролик.
 * Звать только после `presenterLookProblem(...) === null`.
 */
export function presenterSnapshotFrom(
  look: PresenterLookRow,
  variant: GreetingPresenterVariant,
): GreetingPresenterSnapshot {
  const sketch = variant === 'sketch' ? look.activeSketch : null;
  return {
    lookId: look.id,
    label: look.label,
    url: (sketch?.url ?? look.photoUrl)!,
    pathname: sketch ? (sketch.pathname ?? null) : look.photoPathname,
    variant,
  };
}

/**
 * Есть ли в ролике персона автора: образ-ведущий или личный бренд-бук
 * (его голос и подпись). Такой ролик не продаётся и не попадает в витрину
 * без галочки автора (§4.7, §4.9).
 */
export function snapshotUsesPersona(input: {
  presenter?: GreetingPresenterSnapshot | null;
  manifestKind?: string | null;
  /** Голос отправителя — клон голоса персоны (`senderVoice.personaVoice`). */
  senderVoice?: { personaVoice?: boolean } | null;
}): boolean {
  return (
    !!input.presenter ||
    input.manifestKind === 'PERSONAL' ||
    input.senderVoice?.personaVoice === true
  );
}

/**
 * Признак персоны монотонен, как только в сессии стартовал хоть один
 * рендер (CONTRACT5 п.5б): ролик мог уже быть снят с лицом или голосом
 * автора, и смена голоса или ведущего в той же сессии не делает его «без
 * персоны» — иначе снятый ролик ушёл бы на аукцион или в витрину без
 * галочки. Статус рендера не смотрим НАМЕРЕННО: готовый ролик с персоной,
 * перезапущенный на месте и упавший, оставляет `FAILED` поверх уже
 * отданного файла (аудит волны). До первого рендера признак просто
 * следует за выбором.
 */
export function nextUsesPersona(
  previous: boolean | undefined,
  computed: boolean,
  generatedVideo: { status?: unknown } | null | undefined,
): boolean {
  if (computed) return true;
  return previous === true && !!generatedVideo;
}

/** Что нужно от строки `Persona` для решения «годится ли» (структурно). */
export interface PersonaStateRow {
  livenessCheckedAt: Date | string | null;
  revokedAt: Date | string | null;
  verifyResult?: unknown;
}

/**
 * Персона проверена и без отказа (CONTRACT5 п.13): живость пройдена, не
 * отозвана, в итоге проверки нет отказов (`under-18` и прочих). Разбор
 * отказов — тот же, что у экрана персоны (`refusalsOf`).
 */
export function personaUsable(p: PersonaStateRow | null | undefined): boolean {
  if (!p || p.revokedAt || !p.livenessCheckedAt) return false;
  return (refusalsOf(p.verifyResult) ?? []).length === 0;
}

/**
 * Признак персоны в сырых данных сессии (`Session.data` из БД) — для
 * аукциона и витрины, которые читают строку сессии напрямую, в том числе
 * мягко удалённую: удаление сессии не делает лицо на ролике чужим.
 */
export function sessionDataUsesPersona(data: unknown): boolean {
  return briefOfData(data)?.usesPersona === true;
}

/** Галочка автора «можно в витрину» для ролика с персоной (§4.9). */
export function sessionDataShowcaseConsent(data: unknown): boolean {
  return !!briefOfData(data)?.personaShowcaseConsentAt;
}

function briefOfData(
  data: unknown,
): { usesPersona?: unknown; personaShowcaseConsentAt?: unknown } | null {
  if (!data || typeof data !== 'object') return null;
  const brief = (data as { greetingBriefSnapshot?: unknown })
    .greetingBriefSnapshot;
  return brief && typeof brief === 'object'
    ? (brief as { usesPersona?: unknown; personaShowcaseConsentAt?: unknown })
    : null;
}

export const SHOWCASE_NEEDS_AUTHOR_CONSENT =
  'В ролике персона автора («Я в кадре»): в витрину — только с отдельной галочкой автора при публикации.';
export const SHOWCASE_SESSION_UNKNOWN =
  'Сессия этого ролика удалена — нельзя проверить, есть ли в нём персона автора, поэтому в витрину его не добавить.';

/**
 * Можно ли отметить страницу в витрину (§4.9). `null` — можно.
 *
 * Персона бывает только у поздравления, поэтому товарный ролик проходит
 * без чтения сессии. У поздравления без данных сессии (сессию удалили) —
 * отказ: не узнать, есть ли в ролике лицо автора, а ошибка в эту сторону
 * публикует человека без его галочки. При выключенном режиме — без отказа
 * (CONTRACT6 п.7), как до этапа G. Схема страницы признака персоны не
 * хранит (см. отчёт этапа G — предложено добавить колонку).
 */
export function showcaseRefusal(
  projectType: string | null | undefined,
  sessionData: unknown | null | undefined,
  enabled: boolean = personaEnabled(),
): string | null {
  if (projectType !== 'GREETING_VIDEO') return null;
  if (sessionData === null || sessionData === undefined) {
    // CONTRACT6 п.7: при выключенном режиме витрина ведёт себя как до
    // этапа G — стёртая сессия не повод отказать оператору: при
    // выключенном режиме ролик с персоной не снять (рендер отказывает,
    // `personaRenderProblem`). Уцелевшая сессия с персоной и без
    // галочки автора — отказ и при выключенном режиме (ниже).
    return enabled ? SHOWCASE_SESSION_UNKNOWN : null;
  }
  if (
    sessionDataUsesPersona(sessionData) &&
    !sessionDataShowcaseConsent(sessionData)
  ) {
    return SHOWCASE_NEEDS_AUTHOR_CONSENT;
  }
  return null;
}

// ── Лица в референсах (Г-8) ─────────────────────────────────────────────

/**
 * Фото, на котором МОЖЕТ быть лицо, без подтверждённого согласия.
 *
 * Волна исправлений (CONTRACT5 п.4, п.6):
 *  - только при `PERSONA_ENABLED`: распознавание лиц условия
 *    использования ещё не описывают, и при выключенном режиме референсы
 *    ведут себя как до этапа G;
 *  - fail-closed: лицо «может быть», пока проверка прямо не сказала «нет»
 *    (`hasFace === false`). Сбой проверки и старые референсы без отметки
 *    требуют галочки согласия — ошибка в сторону «спросить» дешевле, чем
 *    чужое лицо в видеомодели.
 *
 * Скетч снимает запрет: скетч референса поздравления рисуется
 * слотом-сценой, а его промпт требует «Remove all people» и запрещает
 * узнаваемых людей (`common/sketch-prompts.ts`).
 */
export function referenceNeedsFaceConsent(
  img: SceneAsset,
  enabled: boolean = personaEnabled(),
): boolean {
  if (!enabled) return false;
  return img.hasFace !== false && !img.faceConsentAt && !img.sketch;
}

/**
 * Префикс имени файла сцены бренд-бука, прошедшей проверку лица (п.10).
 * Путь с ним выдаёт ТОЛЬКО сервер при подтверждении фото сцены (клиенту
 * presigned-загрузка даёт лишь `photo.<ext>`), поэтому он и есть отметка
 * «лица нет» — колонки в схеме под неё нет, а схему волна не меняет.
 */
export const FACE_CHECKED_SCENE_PREFIX = 'checked-';

/** Путь фото сцены бренд-бука, прошедшего проверку лица. */
export function isFaceCheckedScenePhoto(
  url: string | null | undefined,
): boolean {
  if (!url) return false;
  try {
    return new RegExp(
      `/scenes/[^/]+/${FACE_CHECKED_SCENE_PREFIX}[a-z0-9]+\\.(png|jpg)$`,
    ).test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Можно ли отправить в модель ИЗОБРАЖЕНИЕ сцены бренд-бука (п.10).
 * Скетч — всегда (он рисует место без людей). Фото:
 *  - при включённом режиме — только проверенное при загрузке; старые,
 *    непроверенные идут словами;
 *  - при выключенном — никогда (CONTRACT6 п.8). До этапа G сцены
 *    бренд-бука в поздравление не попадали вовсе (Г-6), а проверки лица
 *    при выключенном режиме нет — пропуск фото изображением отправлял бы
 *    в видеомодель чьё угодно лицо без вопроса о согласии. Словами сцена
 *    доходит и так.
 */
export function brandSceneImageAllowed(
  scene: Pick<BrandSceneSnapshot, 'photoUrl' | 'sketch'>,
  enabled: boolean = personaEnabled(),
): boolean {
  if (scene.sketch) return true;
  if (!enabled) return false;
  return isFaceCheckedScenePhoto(scene.photoUrl);
}

export function faceConsentRefusal(blocked: SceneAsset[]): string {
  const names = blocked.map((b) => `«${b.label}»`).join(', ');
  return (
    `На фото ${names} есть лицо. Подтвердите, что у вас есть согласие этого человека, ` +
    'превратите фото в скетч (лицо будет заменено) или удалите его — без этого фото не уйдёт в ролик.'
  );
}

// ── Порядок изображений для видеомодели ─────────────────────────────────

export interface GreetingVideoReference {
  /** Откуда: образ-ведущий, фото человека или сцена бренд-бука (Г-6). */
  role: 'presenter' | 'reference' | 'brand-scene';
  url: string;
  /** Подпись рядом с меткой `<IMAGE_n>` в промпте. */
  caption: string;
}

export interface GreetingVideoReferencePlan {
  /** Ровно то, что уйдёт в Grok, в этом порядке; ≤ `max`. */
  refs: GreetingVideoReference[];
  /** Фото с лицом без согласия — не отправляются (Г-8). */
  blocked: SceneAsset[];
  /** Сцены бренд-бука без фото или не поместившиеся — словами в промпт. */
  textScenes: string[];
}

/**
 * Единый порядок изображений для промпта и для рендера:
 *   1. образ-ведущий (§4.8, Т-17: «The presenter is the person shown in
 *      <IMAGE_1>» — поэтому он всегда первый);
 *   2. референсы сессии в порядке загрузки, кроме заблокированных (Г-8);
 *   3. сцены бренд-бука (Г-6) — после своих: то, что человек загрузил
 *      к этому поздравлению, важнее постоянного стиля серии.
 * Потолок общий (`max` — 7 у Grok): образ занимает один слот.
 */
export function greetingVideoReferences(input: {
  presenter?: GreetingPresenterSnapshot | null;
  images: SceneAsset[];
  brandScenes?: BrandSceneSnapshot[] | null;
  max: number;
}): GreetingVideoReferencePlan {
  const refs: GreetingVideoReference[] = [];
  const blocked: SceneAsset[] = [];
  const textScenes: string[] = [];
  if (input.presenter?.url) {
    refs.push({
      role: 'presenter',
      url: input.presenter.url,
      caption: 'the presenter',
    });
  }
  for (const img of input.images) {
    if (referenceNeedsFaceConsent(img)) {
      blocked.push(img);
      continue;
    }
    const url = activeSessionSceneImage(img)?.url;
    if (!url || refs.length >= input.max) continue;
    refs.push({
      role: 'reference',
      url,
      caption: (img.description || img.label).trim(),
    });
  }
  for (const scene of input.brandScenes ?? []) {
    const url = brandSceneImageAllowed(scene)
      ? activeSnapshotSceneImage(scene)?.url
      : null;
    const caption = (scene.description || scene.label).trim();
    if (url && refs.length < input.max) {
      refs.push({ role: 'brand-scene', url, caption });
    } else if (caption) {
      textScenes.push(caption);
    }
  }
  return { refs, blocked, textScenes };
}

/**
 * Портрет говорящего аватара (Hedra, Г-7): выбранный образ, а не «первое
 * фото, какое есть». Без образа (ИИ-ведущий) — прежнее правило, первое
 * фото сессии, но только из разрешённых: фото чужого лица без согласия
 * портретом не станет.
 */
export function hedraPortrait(
  brief: Pick<GreetingBriefSnapshot, 'presenter'>,
  images: SceneAsset[],
  max: number,
): { url: string; fromPresenter: boolean } | null {
  if (brief.presenter?.url) {
    return { url: brief.presenter.url, fromPresenter: true };
  }
  const url = images
    .slice(0, max)
    .filter((img) => !referenceNeedsFaceConsent(img))
    .map((img) => activeSessionSceneImage(img)?.url)
    .find((u): u is string => !!u);
  return url ? { url, fromPresenter: false } : null;
}

/**
 * Этап G — проверки «Я в кадре» и лиц перед сборкой сценария и перед
 * рендером (один и тот же набор в обоих местах, как у политики регистра).
 *
 * 1. Ведущий-образ при выключенном режиме — отказ, а не тихая замена на
 *    ИИ-ведущего: человек выбирал себя, и ролик с чужим лицом вместо
 *    своего — не то, за что он платит.
 * 2. Скетч-ведущий на Hedra — отказ (см. `HEDRA_SKETCH_PRESENTER_REFUSAL`).
 * 3. Голос персоны на Hedra без образа-ведущего — отказ (CONTRACT6 п.3,
 *    `personaVoiceNeedsPresenter`).
 * 4. Фото с лицом без согласия (Г-8) — у Grok все референсы уходят в
 *    модель, поэтому отказ с перечнем фото. У Hedra в модель идёт только
 *    портрет, и заблокированное фото портретом не станет (`hedraPortrait`)
 *    — отказывать там не за что.
 *
 * Лицевой запрет — только при `PERSONA_ENABLED` (CONTRACT5 п.6), см.
 * `referenceNeedsFaceConsent`.
 */
export function assertGreetingReferencesAllowed(
  brief: GreetingBriefSnapshot,
  images: SceneAsset[],
): void {
  if (brief.presenter && !personaEnabled()) {
    throw new BadRequestException({
      code: PERSONA_DISABLED_CODE,
      message: `${PERSONA_DISABLED_MESSAGE} Выберите ИИ-ведущего в брифе.`,
    });
  }
  const providerProblem = presenterProviderProblem(
    brief.resolvedPresenterProvider,
    brief.presenter?.variant,
  );
  if (providerProblem) throw new BadRequestException(providerProblem);
  // CONTRACT6 п.3: голос персоны мог быть выбран при Grok, а провайдер
  // потом сменён в брифе на Hedra (или образ снят) — выбор голоса этого
  // уже не видит, поэтому то же правило и здесь, до денег.
  if (personaVoiceNeedsPresenter(brief, brief.senderVoice)) {
    throw new BadRequestException(
      greetingError(
        GREETING_ERROR_CODES.GREETING_PERSONA_VOICE_NEEDS_PRESENTER,
        PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE,
      ),
    );
  }
  if (brief.resolvedPresenterProvider === 'hedra') return;
  const blocked = images.filter((img) => referenceNeedsFaceConsent(img));
  if (blocked.length) {
    throw new BadRequestException(faceConsentRefusal(blocked));
  }
}
