/**
 * Согласие на генерацию голосом у кнопки генерации — этап K7 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.7.4.
 *
 * Связывает автомат (`lib/voice-consent.ts`) с кнопкой шага «Видео»:
 * регистрирует её как цель согласия (`useVoiceConsentTarget`), на каждое
 * «генерируй» спрашивает цену у ТОГО ЖЕ источника, что кабинет
 * (`GET /referrals/me`: стена, баланс, снятая стена — по ним
 * `RenderAccessService` решает, что списать), и либо показывает сводку,
 * либо зовёт `start` — тот же обработчик, что нажатие. Все серверные
 * проверки старта (тариф, суточный потолок, стена, evaluateGreetingPolicy)
 * остаются на сервере и не знают, голосом нажали или пальцем.
 *
 * Сводка показывается текстом в панели помощника и карточкой у кнопки,
 * а с K4 (§4А.7.4) и ПРОИЗНОСИТСЯ: помощник просит у сервера озвучку
 * сводки (`speak` `consent-summary`) — сервер собирает её сам из снимка
 * брифа и цены, клиентский текст в синтез не уходит. Один раз на
 * отпечаток сводки: второе «генерируй» при той же сводке — запуск, а не
 * повтор цены.
 */

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../lib/i18n-context';
import {
  CONSENT_INITIAL,
  CONSENT_WINDOW_MS,
  chargeText,
  consentReducer,
  renderChargeOf,
  runConsent,
  type ConsentEffect,
  type ConsentEvent,
  type ConsentInput,
  type ConsentState,
  type ConsentSummary,
} from '../../lib/voice-consent';
import { getInviteState } from '../../services/invite-api';
import { useVoiceConsentTarget, type VoiceConsentLine } from './voice-commands';
import { announceProactive } from './voice-proactive-bus';

export interface RenderConsentInput extends ConsentInput {
  /** Обработчик кнопки генерации — ровно тот, что у `onClick`. */
  start: () => void;
}

export function useRenderVoiceConsent(input: RenderConsentInput): {
  summary: ConsentSummary | null;
  cancel: () => void;
} {
  const { dict, locale } = useI18n();
  const c = dict.voiceConsent;
  const [state, setState] = useState<ConsentState>(CONSENT_INITIAL);
  // Автомат читается через ref: реплики приходят асинхронно, и решение
  // «вторая ли это фраза» обязано видеть состояние СЕЙЧАС.
  const stateRef = useRef(state);
  const inputRef = useRef(input);
  inputRef.current = input;

  const step = (event: ConsentEvent): ConsentEffect => {
    const r = consentReducer(stateRef.current, event);
    stateRef.current = r.state;
    setState(r.state);
    return r.effect;
  };

  // Окно истекло — сводка уходит с экрана сама: висящая цена, на которую
  // уже нельзя согласиться, путает больше, чем её отсутствие.
  useEffect(() => {
    if (state.phase !== 'shown') return;
    const left = state.shownAt + CONSENT_WINDOW_MS + 1 - Date.now();
    const id = setTimeout(
      () => step({ type: 'tick', at: Date.now() }),
      Math.max(0, left)
    );
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- таймер на конкретную показанную сводку
  }, [state]);

  const lineOf = (effect: ConsentEffect): VoiceConsentLine | null => {
    switch (effect.kind) {
      case 'summary': {
        const s = effect.summary;
        return {
          tone: 'info',
          text: effect.changed
            ? c.changedLine
            : c.summaryLine
                .replace('{recipient}', s.recipient)
                .replace('{occasion}', s.occasion)
                .replace('{quality}', s.quality)
                .replace('{cost}', chargeText(s.charge, c, locale) ?? ''),
        };
      }
      case 'start':
        return { tone: 'success', text: c.started };
      case 'closed':
        return { tone: 'info', text: c.closed };
      case 'none':
        return null;
      case 'refuse': {
        const text = {
          'pending-card': c.refusePendingCard,
          'low-confidence': c.refuseLowConfidence,
          'no-price': c.refuseNoPrice,
          locked: c.refuseLocked,
          busy: c.refuseBusy,
          'in-progress': c.refuseInProgress,
          done: c.refuseDone,
          flagged: dict.greetingUi.refuseFlagged,
          'not-ready': dict.greetingUi.refuseNotReady,
        }[effect.reason];
        return { tone: 'warning', text };
      }
    }
  };

  const isCurrentTarget = useVoiceConsentTarget({
    isOpen: () => stateRef.current.phase === 'shown',
    consent: async (confidence, hasPendingCard, isCurrent) => {
      // Цена — свежая на каждую фразу: пополненный или потраченный между
      // двумя «генерируй» баланс меняет отпечаток, и старта не будет.
      const effect = await runConsent({
        confidence,
        hasPendingCard,
        fetchCharge: () =>
          getInviteState()
            .catch(() => null)
            .then(renderChargeOf),
        stillValid: () => isCurrent() && isCurrentTarget(),
        read: () => inputRef.current,
        step,
        start: () => inputRef.current.start(),
        now: Date.now,
      });
      if (effect?.kind === 'summary') {
        announceProactive({
          kind: 'consent-summary',
          fingerprint: effect.summary.fingerprint,
        });
      }
      return effect ? lineOf(effect) : null;
    },
    cancel: () => lineOf(step({ type: 'cancel' })),
    interrupt: () => {
      step({ type: 'interrupt' });
    },
  });

  return {
    summary: state.phase === 'shown' ? state.summary : null,
    cancel: () => {
      step({ type: 'cancel' });
    },
  };
}
