/**
 * Согласие на генерацию голосом — этап K7 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.7.4.
 *
 * Самое строгое место голоса: оно тратит деньги. Сервер уже пропускает
 * согласие только фразой из закрытого списка с уверенностью не ниже
 * порога, не при карточке «я понял так» и не без сценария
 * (`isConsentPhrase`, `CONSENT_CONFIDENCE_MIN` в
 * `backend/src/common/greeting-voice-intent.ts`). Здесь — вторая половина
 * правила: «согласие без названной цены — не согласие». Поэтому первое
 * «генерируй» ничего не запускает, а показывает СВОДКУ — кому, повод,
 * качество и сколько спишет; и только второе «генерируй» в течение окна
 * и при той же сводке (отпечаток не изменился) нажимает ту же кнопку.
 *
 * Конечный автомат без React и без часов: время приходит событием —
 * так окно, смена отпечатка и отказы проверяются
 * `scripts/voice-consent.test.ts` без браузера.
 */

/**
 * Порог уверенности согласия — зеркало `CONSENT_CONFIDENCE_MIN`
 * сервера. Сервер ниже него согласия не отдаёт; клиент проверяет ещё
 * раз, чтобы ослабленный или подменённый ответ не стал деньгами.
 */
export const CONSENT_CONFIDENCE_MIN = 0.85;

/** Сколько живёт показанная сводка: дольше — человек мог забыть цену. */
export const CONSENT_WINDOW_MS = 60_000;

/**
 * Что спишет старт рендера. Зеркало `RenderAccessService.assertCanRender`
 * (backend/src/modules/render-access) по данным кабинета
 * (`GET /referrals/me`: стена, баланс генераций, снятая стена):
 *
 *  - `credit`   — спишется одна генерация из баланса;
 *  - `included` — генерации не списываются (подписка, снятая стена или
 *    стена выключена и кредитов нет): рендер идёт в суточный лимит тарифа;
 *  - `unknown`  — назвать цену нельзя (нет данных; стена без кредитов —
 *    сервер может выдать приветственную генерацию или показать стену),
 *    и тогда согласия голосом нет вовсе: только кнопка.
 */
export type RenderCharge =
  | { kind: 'credit'; balance: number }
  | { kind: 'included' }
  | { kind: 'unknown'; reason: 'no-data' | 'locked' };

/** Поля кабинета, от которых зависит цена (подмножество `InviteState`). */
export interface ChargeFacts {
  wallEnabled: boolean;
  generationsAvailable: number;
  unlocked: boolean;
}

export function renderChargeOf(facts: ChargeFacts | null): RenderCharge {
  if (!facts) return { kind: 'unknown', reason: 'no-data' };
  const balance = Math.max(0, Math.floor(facts.generationsAvailable));
  if (!facts.wallEnabled) {
    // Рубильник выключен: кредит, если он есть, иначе суточный лимит.
    return balance > 0 ? { kind: 'credit', balance } : { kind: 'included' };
  }
  // Право (подписка или снятая стена) — кредит не трогается вовсе.
  if (facts.unlocked) return { kind: 'included' };
  if (balance > 0) return { kind: 'credit', balance };
  return { kind: 'unknown', reason: 'locked' };
}

/** С чем соглашаются — то, что человек видит и слышит перед запуском. */
export interface ConsentSummary {
  recipient: string;
  /** Повод человеческими словами (уже подписанный на языке интерфейса). */
  occasion: string;
  /** Качество: разрешение и ведущий (`1080p · Grok`). */
  quality: string;
  charge: RenderCharge;
  /** Отпечаток всего, что влияет на ролик и цену (`consentFingerprint`). */
  fingerprint: string;
}

/** Всё, что меняет ролик или цену: поменялось — сводка устарела. */
export interface ConsentFacts {
  sessionId: string;
  promptId: string | null;
  scriptText: string;
  recipient: string;
  occasion: string;
  customOccasion: string | null;
  resolution: string;
  presenter: string;
  charge: RenderCharge;
}

/** djb2 — не криптография, а сравнение «то же ли самое». */
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export function consentFingerprint(f: ConsentFacts): string {
  const charge =
    f.charge.kind === 'credit'
      ? `credit:${f.charge.balance}`
      : f.charge.kind === 'unknown'
        ? `unknown:${f.charge.reason}`
        : 'included';
  return [
    f.sessionId,
    f.promptId ?? '',
    `${f.scriptText.length}:${hashText(f.scriptText)}`,
    f.recipient,
    f.occasion,
    f.customOccasion ?? '',
    f.resolution,
    f.presenter,
    charge,
  ].join('|');
}

export type ConsentState =
  | { phase: 'idle' }
  | { phase: 'shown'; summary: ConsentSummary; shownAt: number };

export const CONSENT_INITIAL: ConsentState = { phase: 'idle' };

/** Почему старт сейчас невозможен вообще (кнопки нет или она занята). */
export type ConsentBlock = 'busy' | 'in-progress' | 'done';

export type ConsentEvent =
  /** Сервер отдал `consent`. `summary` — сводка по СЕЙЧАС (null — старт недоступен). */
  | {
      type: 'consent';
      at: number;
      confidence: number;
      /** На экране карточка «я понял так» — «согласен» относится к ней. */
      hasPendingCard: boolean;
      summary: ConsentSummary;
      block: ConsentBlock | null;
    }
  /** «Нет»/«отмена» голосом или кнопка «Отмена» на сводке. */
  | { type: 'cancel' }
  /** Любая другая реплика-действие: цепочка «сводка → согласие» прервана. */
  | { type: 'interrupt' }
  /** Часы: сводка могла истечь, пока человек молчал. */
  | { type: 'tick'; at: number };

export type ConsentEffect =
  | { kind: 'none' }
  /** Показать сводку. `changed` — прежняя устарела (условия поменялись). */
  | { kind: 'summary'; summary: ConsentSummary; changed: boolean }
  /** Нажать ТУ ЖЕ кнопку генерации. */
  | { kind: 'start' }
  | {
      kind: 'refuse';
      reason:
        | 'pending-card'
        | 'low-confidence'
        | 'no-price'
        | 'locked'
        | ConsentBlock;
    }
  | { kind: 'closed' };

export function isExpired(state: ConsentState, at: number): boolean {
  return state.phase === 'shown' && at - state.shownAt > CONSENT_WINDOW_MS;
}

/**
 * @returns новое состояние и что сделать экрану. `start` — единственный
 * путь к деньгам, и он возможен ровно в одном случае: сводка с ценой
 * показана, окно не истекло, отпечаток тот же, уверенность не ниже
 * порога и карточки «я понял так» на экране нет.
 */
export function consentReducer(
  state: ConsentState,
  event: ConsentEvent
): { state: ConsentState; effect: ConsentEffect } {
  switch (event.type) {
    case 'cancel':
    case 'interrupt':
      return state.phase === 'shown'
        ? { state: CONSENT_INITIAL, effect: { kind: 'closed' } }
        : { state, effect: { kind: 'none' } };
    case 'tick':
      return isExpired(state, event.at)
        ? { state: CONSENT_INITIAL, effect: { kind: 'closed' } }
        : { state, effect: { kind: 'none' } };
    case 'consent': {
      // Карточка на экране: «согласен» — ответ на неё, а не деньги. Сводку
      // не трогаем — её цепочка не прервана, просто это реплика не ей.
      if (event.hasPendingCard) {
        return { state, effect: { kind: 'refuse', reason: 'pending-card' } };
      }
      if (event.block) {
        return {
          state: CONSENT_INITIAL,
          effect: { kind: 'refuse', reason: event.block },
        };
      }
      const { summary } = event;
      // Без названной цены согласия нет: ни сводки «на потом», ни старта.
      if (summary.charge.kind === 'unknown') {
        return {
          state: CONSENT_INITIAL,
          effect: {
            kind: 'refuse',
            reason: summary.charge.reason === 'locked' ? 'locked' : 'no-price',
          },
        };
      }
      // Неуверенно расслышанное — переспрос; открытая сводка остаётся.
      if (!(event.confidence >= CONSENT_CONFIDENCE_MIN)) {
        return { state, effect: { kind: 'refuse', reason: 'low-confidence' } };
      }
      const live =
        state.phase === 'shown' && !isExpired(state, event.at) ? state : null;
      if (live && live.summary.fingerprint === summary.fingerprint) {
        return { state: CONSENT_INITIAL, effect: { kind: 'start' } };
      }
      return {
        state: { phase: 'shown', summary, shownAt: event.at },
        effect: { kind: 'summary', summary, changed: live !== null },
      };
    }
  }
}

/**
 * Куда идёт разобранная реплика относительно сводки перед генерацией.
 *
 *  - `consent`   — в автомат согласия (и только туда: у реестра интентов
 *    обработчика `consent` нет, деньги не должны зависеть от порядка
 *    регистрации);
 *  - `cancel`    — «нет» без карточки «я понял так» при открытой сводке;
 *  - `interrupt` — другое действие (поле, команда): цепочка прервана,
 *    сводка закрывается, реплика идёт обычным путём;
 *  - `hint`      — «да», «ага», непонятое при открытой сводке: не
 *    согласие и не отказ — подсказать, что сказать для запуска;
 *  - `pass`      — обычный путь, сводку не трогаем (справка, переход по
 *    шагам; ответы карточке «я понял так»).
 *
 * «Нет» при карточке — ответ ей, а не сводке: карточка ближе к вопросу.
 */
export function consentRoute(
  intentKind: string | null | undefined,
  hasPendingCard: boolean,
  summaryOpen: boolean
): 'consent' | 'cancel' | 'interrupt' | 'hint' | 'pass' {
  if (intentKind === 'consent') return 'consent';
  if (!summaryOpen) return 'pass';
  // Карточка «я понял так» ближе к вопросу: «да»/«нет» — ей.
  if (hasPendingCard) {
    return intentKind === 'fill' || intentKind === 'command'
      ? 'interrupt'
      : 'pass';
  }
  if (intentKind === 'cancel') return 'cancel';
  // «Да», «ага», непонятое (сервер отдаёт «да» без карточки как
  // `unknown`) при открытой сводке — не согласие, но и не «подтверждать
  // нечего»: человек отвечает сводке, и ему нужна подсказка, ЧТО сказать.
  if (!intentKind || intentKind === 'unknown' || intentKind === 'confirm') {
    return 'hint';
  }
  // Справка и переход ничего не меняют в данных — сводка переживает
  // и «что здесь», и «назад к сценарию» (финальный аудит): отпечаток всё
  // равно не даст запустить то, что успело поменяться.
  if (intentKind === 'help' || intentKind === 'navigate') return 'pass';
  return 'interrupt';
}

/** Цена человеческими словами; `null` — назвать нельзя (согласия нет). */
export function chargeText(
  charge: RenderCharge,
  texts: { costCredit: string; costIncluded: string }
): string | null {
  switch (charge.kind) {
    case 'credit':
      return texts.costCredit.replace('{balance}', String(charge.balance));
    case 'included':
      return texts.costIncluded;
    case 'unknown':
      return null;
  }
}

/** Что нужно знать о кнопке генерации в момент реплики. */
export interface ConsentInput {
  /** Всё, что меняет ролик, кроме цены (цена — на момент реплики). */
  facts: Omit<ConsentFacts, 'charge'>;
  /** Повод и качество — уже подписанные для экрана. */
  occasionLabel: string;
  qualityLabel: string;
  /** Почему кнопка сейчас не нажимается; `null` — нажимается. */
  block: ConsentBlock | null;
}

/**
 * Одна фраза согласия целиком: узнать цену (сеть), решить, нажать.
 *
 * Между запросом цены и решением проходит время — за него шаг «Видео»
 * мог смениться (новая сессия) или сняться с экрана. Поэтому после
 * ожидания проверяется, что реплика ещё актуальна, цель — всё та же
 * зарегистрированная, и сессия та же, что была до ожидания; иначе —
 * ничего (аудит волны 2: старый экземпляр запускал рендер старой сессии).
 */
export async function runConsent(deps: {
  confidence: number;
  hasPendingCard: boolean;
  fetchCharge: () => Promise<RenderCharge>;
  /** Реплика актуальна и эта кнопка — текущая цель согласия. */
  stillValid: () => boolean;
  read: () => ConsentInput;
  step: (event: ConsentEvent) => ConsentEffect;
  start: () => void;
  now: () => number;
}): Promise<ConsentEffect | null> {
  const sessionBefore = deps.read().facts.sessionId;
  const charge = await deps.fetchCharge();
  if (!deps.stillValid()) return null;
  const input = deps.read();
  if (input.facts.sessionId !== sessionBefore) return null;
  const effect = deps.step({
    type: 'consent',
    at: deps.now(),
    confidence: deps.confidence,
    hasPendingCard: deps.hasPendingCard,
    block: input.block,
    summary: {
      recipient: input.facts.recipient,
      occasion: input.occasionLabel,
      quality: input.qualityLabel,
      charge,
      fingerprint: consentFingerprint({ ...input.facts, charge }),
    },
  });
  if (effect.kind === 'start') deps.start();
  return effect;
}
