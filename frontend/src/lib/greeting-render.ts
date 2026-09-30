/**
 * Шаг «Видео» мастера поздравления: опрос рендера и право нажать
 * «Сгенерировать» (CONTRACT6 G-FE п. 1 и 4).
 *
 * Чистые функции без React и axios — чтобы правила проверялись тестом
 * (scripts/greeting-render.test.ts), а не только руками в браузере.
 */

import type { Readiness } from '../types';

// ── Опрос рендера ─────────────────────────────────────────────────────────

/** Обычный шаг опроса — как было до backoff. */
export const RENDER_POLL_BASE_MS = 4000;
/** Потолок паузы между попытками при сбоях связи. */
export const RENDER_POLL_MAX_MS = 60_000;

/**
 * Пауза до следующего опроса после `failures` сбоев подряд.
 *
 * Раньше первый же сетевой сбой гасил опрос насовсем: человек в метро
 * терял связь на секунду, и экран до перезагрузки показывал «видео
 * генерируется», хотя ролик давно был готов. Теперь сбой — повод
 * подождать дольше (удвоение, но не больше минуты), а не сдаться.
 */
export function renderPollDelay(failures: number): number {
  if (!(failures > 0)) return RENDER_POLL_BASE_MS;
  const exp = Math.min(failures, 10);
  return Math.min(RENDER_POLL_BASE_MS * 2 ** exp, RENDER_POLL_MAX_MS);
}

/**
 * Что делать с ошибкой опроса по HTTP-статусу.
 *
 * `retry` — связь или временный сбой сервера: нет ответа, 408, 429, 5xx.
 * `stop` — остальные 4xx (сессия удалена, чужая, нужен вход): тот же
 * запрос получит тот же ответ, и крутить его каждую минуту бессмысленно —
 * экран показывает причину и кнопку «Обновить».
 */
export function renderPollErrorKind(
  httpStatus: number | undefined | null
): 'retry' | 'stop' {
  if (!httpStatus) return 'retry';
  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) {
    return 'retry';
  }
  return httpStatus >= 400 ? 'stop' : 'retry';
}

// ── Кнопка рендера ───────────────────────────────────────────────────────

/**
 * Почему кнопка «Сгенерировать» (и согласие голосом) сейчас не
 * нажимается; `null` — нажимается.
 *
 * - `flagged` — сценарий не прошёл проверку (FLAGGED) или прошёл её в
 *   обход (BYPASSED, ручное одобрение старых версий): сервер откажет
 *   `GREETING_SCRIPT_FLAGGED` и в том, и в другом случае;
 * - `not-ready` — не выполнен обязательный пункт готовности (сервер
 *   считает их по тем же фактам, по которым отказывает в рендере).
 *
 * Готовность не загрузилась (`null`) — кнопка НЕ гаснет: решает сервер,
 * а выдуманный клиентом запрет хуже честного отказа.
 */
export type RenderBlock = 'flagged' | 'not-ready';

export function renderBlockOf(input: {
  moderationStatus: string | null | undefined;
  readiness: Pick<Readiness, 'items'> | null | undefined;
}): RenderBlock | null {
  const m = input.moderationStatus;
  if (m === 'flagged' || m === 'bypassed') return 'flagged';
  const missing = input.readiness?.items.some((i) => i.required && !i.done);
  return missing ? 'not-ready' : null;
}

/** Ролик в работе — правки, меняющие ролик, ждут (CONTRACT6 G-FE п. 5). */
export function isVideoBusy(
  status: string | null | undefined
): status is 'pending' | 'processing' {
  return status === 'pending' || status === 'processing';
}

// ── Озвучка не легла (аудит S2) ──────────────────────────────────────────

/**
 * Готовый ролик, на который не легла наша речь. Постобработка пишет
 * `voiceStatus`: `failed` — синтез провалился, `skipped` — озвучивать
 * было нечем (провайдер не настроен, текста нет). При своём голосе и
 * голосе Soniox Grok снимает БЕЗ звука, так что оба исхода — немой
 * ролик, и молчать об этом экран не должен.
 *
 * - `kind` — какой из двух исходов (разные слова для человека);
 * - `canRevoice` — предложить «Переозвучить»: дорожка поверх готового
 *   ролика без нового рендера. Только при `failed` (сбой мог быть
 *   разовым; при `skipped` повтор упрётся в ту же причину) и не у
 *   Hedra — там речь аватара синтезируется до рендера, и дорожка поверх
 *   дала бы вторую речь.
 */
export interface VoiceTrackIssue {
  kind: 'failed' | 'skipped';
  canRevoice: boolean;
}

export function voiceTrackIssue(
  video:
    | {
        status: string;
        postStatus?: string | null;
        voiceStatus?: string | null;
      }
    | null
    | undefined,
  ctx: {
    /** Вид голоса из карточки (`senderVoiceKind`); `null` — не прочитан. */
    voiceKind: 'clone' | 'preset' | 'soniox' | 'default' | null;
    presenter: string;
  }
): VoiceTrackIssue | null {
  if (!video || video.status !== 'complete') return null;
  // Переозвучка идёт — итог ещё не известен.
  if (video.postStatus === 'pending') return null;
  const hedra = ctx.presenter === 'hedra';
  if (video.voiceStatus === 'failed') {
    return { kind: 'failed', canRevoice: !hedra };
  }
  // `skipped` штатен, когда речь звучит и без нас: пресет (говорит модель),
  // Hedra (речь аватара), голос по умолчанию. Тревога — только когда наша
  // дорожка была единственной речью ролика; не прочитан голос — молчим.
  if (
    video.voiceStatus === 'skipped' &&
    !hedra &&
    (ctx.voiceKind === 'clone' || ctx.voiceKind === 'soniox')
  ) {
    return { kind: 'skipped', canRevoice: false };
  }
  return null;
}

/**
 * Когда останавливать опрос. Обычно — когда рендер закончен; после
 * «Переозвучить» ролик уже `complete`, и ждать надо конца постобработки
 * (`postStatus` уходит из `pending`), иначе экран так и показал бы
 * старую плашку «озвучка не легла».
 */
export function pollSettled(
  video: { status: string; postStatus?: string | null } | null | undefined,
  awaitingRevoice: boolean
): boolean {
  // Ответа о ролике нет — как раньше (`isTerminal`): спрашиваем дальше.
  if (!video) return false;
  if (isVideoBusy(video.status)) return false;
  return !(awaitingRevoice && video.postStatus === 'pending');
}

/**
 * Отказ старта из-за голоса (аудит S2): у такого отказа выход — сменить
 * голос, и рядом с текстом ошибки уместна кнопка к карточке голоса. До
 * рендера карточки открыты, так что выход настоящий.
 */
export const VOICE_START_ERROR_CODES = [
  'GREETING_SONIOX_UNAVAILABLE',
  'GREETING_SONIOX_VOICE_UNKNOWN',
  'GREETING_AVATAR_SPEECH_FAILED',
] as const;

export function isVoiceStartError(code: string | null | undefined): boolean {
  return (VOICE_START_ERROR_CODES as readonly string[]).includes(code ?? '');
}
