/**
 * Отпечаток входов сценария поздравления (CONTRACT6, G-B1 п.4).
 *
 * ## Зачем
 *
 * Сцена (`buildSceneDescription`) вшивает в текст то, что было на момент
 * сборки: метки `<IMAGE_n>` по позиции фото, строку ведущего-образа,
 * `<AUDIO_0>` пресетного голоса, «молчаливую» формулировку при нашей
 * озвучке. Фото, голос или образ можно сменить ПОСЛЕ сборки — и рендер
 * ушёл бы со сценарием, у которого метки смотрят не на те картинки, а
 * ведущий то говорит, то молчит невпопад. Деньги при этом списаны.
 *
 * Поэтому при сборке (и правке) сценария в `generationPrompt` кладётся
 * отпечаток этих входов, а `startVideo` сверяет его с текущими — ДО
 * списания. Не совпало — отказ «сценарий устарел», а не тихий ролик с
 * перепутанными фото.
 *
 * ## Что входит
 *
 * Ровно то, от чего зависит текст сцены или голос ролика:
 * - свои фото по порядку: id, подпись (она и есть подпись метки) и
 *   блокировка лица (заблокированное фото выпадает из меток — Г-8);
 * - сцены бренд-бука по порядку: id, подпись и уходит ли фото картинкой;
 * - ведущий-образ: id образа и вариант (фото/скетч);
 * - голос: пресет xAI, клон отправителя, режим озвучки бренда.
 *
 * Клон отправителя в текст сцены не попадает, но входит по контракту
 * волны: смена голоса после сборки — это другой ролик, и человек должен
 * увидеть сценарий с новым голосом до оплаты, а не после.
 *
 * Не входят: адрес картинки (новая версия сессии копирует фото в свою
 * папку — адрес другой, а метки те же), разрешение и провайдер (сцена от
 * них не зависит).
 */

import { SceneAsset } from '../../common/types/reference.types';
import { GreetingBriefSnapshot } from '../../common/types/greeting.types';
import { BrandManifestSnapshot } from '../../common/types/brand-manifest.types';
import {
  brandSceneImageAllowed,
  referenceNeedsFaceConsent,
} from '../../common/greeting-persona';
import { normalizeVoiceMode } from '../../common/voice-mode';
import { ConflictException } from '@nestjs/common';
import {
  GREETING_ERROR_CODES,
  greetingError,
} from '../../common/greeting-errors';
import {
  GREETING_EDIT_BUSY_MESSAGE,
  editModeOf,
} from '../../common/greeting-session-edit';
import type { Session } from '../../common/types/session.types';

/**
 * Срок замка 'prompt' у ВСЕХ, кто его берёт по поздравлению: сборка и
 * правка сценария, правка брифа, смена голоса, старт ролика (CONTRACT6
 * п.5 аудита). `claimWork` считает чужой замок протухшим по сроку ТОГО,
 * КТО ПРОСИТ: при 60 с у правки и 5 мин у старта правка забирала замок
 * у ещё идущего старта Hedra (синтез + вызов), и ролик уходил со старым
 * сценарием при новом брифе. Один срок, не меньше потолка функции
 * (300 с), — живого держателя не отнимет никто; цена — умерший
 * экземпляр держит правку до 5 минут, это редкий сбой, а не каждый клик.
 */
export const GREETING_PROMPT_LOCK_TTL_MS = 5 * 60 * 1000;

export interface GreetingScriptInputsSource {
  greetingBriefSnapshot?: Pick<
    GreetingBriefSnapshot,
    'presenter' | 'presetVoiceId' | 'senderVoice' | 'sonioxVoice'
  > | null;
  greetingReferenceImages?: SceneAsset[] | null;
  brandManifestSnapshot?: Pick<
    BrandManifestSnapshot,
    'voiceMode' | 'scenes'
  > | null;
}

export function greetingScriptInputs(s: GreetingScriptInputsSource): string {
  const brief = s.greetingBriefSnapshot ?? null;
  const caption = (label?: string | null, description?: string | null) =>
    (description || label || '').trim();
  return JSON.stringify({
    images: (s.greetingReferenceImages ?? []).map((img) => [
      img.id,
      caption(img.label, img.description),
      referenceNeedsFaceConsent(img) ? 1 : 0,
    ]),
    brandScenes: (s.brandManifestSnapshot?.scenes ?? []).map((sc) => [
      sc.sourceSceneId ?? null,
      caption(sc.label, sc.description),
      sc.photoUrl && brandSceneImageAllowed(sc) ? 1 : 0,
    ]),
    presenter: brief?.presenter
      ? [brief.presenter.lookId, brief.presenter.variant ?? null]
      : null,
    presetVoiceId: brief?.presetVoiceId?.trim() || null,
    clone: brief?.senderVoice?.resembleVoiceId ?? null,
    voiceMode: normalizeVoiceMode(s.brandManifestSnapshot?.voiceMode),
    // S2: голос Soniox меняет строку сцены (ведущий молчит, речь поверх),
    // значит, и сценарий. Ключ — только когда голос выбран: иначе
    // отпечаток КАЖДОЙ уже собранной сессии сменился бы от одной этой
    // правки, и все они разом получили бы «сценарий устарел».
    // `null` — голос Soniox по умолчанию (ключ есть, значение пусто).
    ...(brief?.sonioxVoice
      ? { soniox: brief.sonioxVoice.voiceId ?? null }
      : {}),
  });
}

/**
 * Устарел ли сценарий. Сценарий без отпечатка (собран до этой правки) —
 * не устаревший: сверить не с чем, и отказывать всем прежним сессиям
 * задним числом было бы хуже, чем пропустить их как раньше.
 */
export function greetingScriptStale(
  prompt: { greetingScriptInputs?: string | null } | null | undefined,
  current: GreetingScriptInputsSource,
): boolean {
  const saved = prompt?.greetingScriptInputs;
  if (!saved) return false;
  return saved !== greetingScriptInputs(current);
}

/** Правка брифа/сценария, пока ролик считается (`editModeOf` → busy). */
export function editDuringRender(): ConflictException {
  return new ConflictException(
    greetingError(
      GREETING_ERROR_CODES.GREETING_CHANGE_DURING_RENDER,
      GREETING_EDIT_BUSY_MESSAGE,
    ),
  );
}

export const GREETING_EDIT_AFTER_RENDER_STARTED_MESSAGE =
  'Ролик уже запущен — правка не сохранена. Дождитесь готового ролика и поправьте бриф: ' +
  'появится новая версия.';

/**
 * CONTRACT6 п.3, страховка после записи правки. Старт ролика и правка
 * разведены замком 'prompt', но у замка есть TTL: старт, переживший
 * TTL правки, мог записать ролик между её перечитыванием и записью.
 * Тогда ролик считается по ПРЕЖНЕМУ сценарию/брифу — возвращаем их
 * (`restore`) и отказываем с кодом, а не оставляем в сессии текст,
 * которого в ролике нет.
 */
export async function assertNoRenderAfterWrite(
  sessions: {
    getSession(id: string): Promise<Session | null | undefined>;
    updateSession(id: string, patch: Partial<Session>): Promise<unknown>;
  },
  sessionId: string,
  restore: Partial<Session>,
): Promise<void> {
  const after = await sessions.getSession(sessionId);
  if (editModeOf(after?.generatedVideo) !== 'busy') return;
  await sessions.updateSession(sessionId, restore);
  throw new ConflictException(
    greetingError(
      GREETING_ERROR_CODES.GREETING_EDIT_AFTER_RENDER_STARTED,
      GREETING_EDIT_AFTER_RENDER_STARTED_MESSAGE,
    ),
  );
}
