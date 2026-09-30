/**
 * Разбор голосовой реплики мастера поздравления — этап K3 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.2 п.3–5,
 * §4А.7.1, §4А.7.4.
 *
 * Распознавание (K2) отдаёт дословный текст; этот модуль — всё, что
 * между текстом и карточкой «я понял так»: инструкция модели разбора,
 * недоверчивое чтение её ответа, проверка значений против ДОСТУПНОГО в
 * текущем состоянии и реплика помощника. Чистые функции без Nest и сети:
 * всё, что имеет смысл проверять, проверяется здесь перебором, а сервис
 * только зовёт модель и складывает.
 *
 * ## Три правила, из которых растёт остальное
 *
 * 1. **Модели не верим ни в чём.** Её ответ — непроверенные данные:
 *    форма (`normalizeModelAnswer`), значения (`validateField`),
 *    уверенность (число в [0, 1], иначе ноль). Сломанный JSON — не
 *    исключение, а `unknown` с переспросом.
 * 2. **Неуверенное не применяется** (§4А.7.1): ниже `FIELD_CONFIDENCE_MIN`
 *    поле не попадает в карточку, а помощник переспрашивает НАЗВАНИЕМ
 *    ПОЛЯ — «не расслышал: Кому», а не молча пишет ближайшее похожее.
 * 3. **Недоступное недоступно и голосом.** Тон, запрещённый регистром
 *    повода (`greeting-policy.ts`), Hedra не на Premium, качество выше
 *    тарифа — поле не возвращается, а реплика называет ту же причину, что
 *    написана на экране.
 *
 * Сервер ничего не применяет: он только разбирает. Применяет клиент после
 * «Да», теми же обработчиками, что и ручной ввод, и сервер при сохранении
 * брифа проверяет всё ещё раз (`GreetingBriefService.resolveNext`).
 *
 * ## Как разложен модуль
 *
 * Файл вырос до трёх тысяч строк и разрезан по естественным швам;
 * зависимости идут в одну сторону, без циклов:
 *
 *   contract ← phrases ← replies ← validate ← prompt; ядро (этот файл)
 *   берёт из всех.
 *
 * - `greeting-voice-contract.ts` — пороги, контракт ответа, хуки, потолки;
 * - `greeting-voice-phrases.ts` — нормализация и закрытые списки фраз;
 * - `greeting-voice-replies.ts` — реплики помощника на пяти языках;
 * - `greeting-voice-validate.ts` — ответ модели, значения, команды;
 * - `greeting-voice-prompt.ts` — инструкция модели разбора;
 * - здесь — `resolveIntent`, итог разбора.
 *
 * Все прежние имена по-прежнему экспортируются ОТСЮДА (реэкспорт ниже):
 * сервисы, DTO, спеки и клиентские тесты (`frontend/scripts/voice-*`)
 * импортируют этот файл и не должны знать о разрезе.
 */

import {
  CONSENT_CONFIDENCE_MIN,
  FIELD_CONFIDENCE_MIN,
  SESSION_FIELD_HOOKS,
  SESSION_FIELD_NAMES,
  VoiceField,
  VoiceIntent,
  VoiceRefusalCode,
  VoiceUnderstandContext,
  briefFieldOf,
  fieldNameOf,
  hookOf,
  isSessionField,
  sessionCardShown,
} from './greeting-voice-contract';
import {
  CANCEL_PHRASES,
  consentHint,
  isConsentPhrase,
  normalizeUtterance,
  stripPolite,
} from './greeting-voice-phrases';
import { REPLIES } from './greeting-voice-replies';
import {
  ModelAnswer,
  applyToEffective,
  checkCommand,
  conflictingSessionFields,
  effectiveOf,
  orderOf,
  validateField,
  validateSessionField,
} from './greeting-voice-validate';

export {
  FIELD_CONFIDENCE_MIN,
  CONSENT_CONFIDENCE_MIN,
  VOICE_STATUSES,
  VOICE_REASONS,
  GREETING_VOICE_MAX_BYTES,
  VOICE_UTTERANCE_MAX_MS,
  greetingVoiceMaxBytesFor,
  VOICE_COMMANDS,
  VOICE_NAVIGATE_TARGETS,
  VOICE_QUESTION_TOPICS,
  VOICE_REFUSAL_CODES,
  VOICE_SCREEN_STEPS,
  BRIEF_FIELD_HOOKS,
  BRIEF_FIELDS,
  briefFieldOf,
  fieldTitle,
  FIELD_NAMES,
  SESSION_FIELD_HOOKS,
  SESSION_FIELDS,
  sessionFieldOf,
  voiceFieldOf,
  isSessionField,
  hookOf,
  SESSION_FIELD_NAMES,
  fieldNameOf,
  VOICE_REFERENCE_LABEL_MAX,
  VOICE_REFERENCE_DESCRIPTION_MAX,
  VOICE_SCRIPT_MAX,
  VOICE_SEARCH_QUERY_MAX,
  sessionCardShown,
  briefStateFromRow,
  briefStateFromSnapshot,
  replyLocaleOf,
} from './greeting-voice-contract';
export type {
  VoiceStatus,
  VoiceReason,
  VoiceField,
  VoiceCommand,
  VoiceNavigateTarget,
  VoiceQuestionTopic,
  VoiceRefusalCode,
  VoiceIntent,
  VoiceUnderstandResult,
  VoiceScreenStep,
  VoicePending,
  BriefField,
  SessionFieldKind,
  SessionFieldHookSpec,
  SessionField,
  VoiceFieldKey,
  VoiceSessionState,
  VoiceBriefState,
  VoiceUnderstandContext,
} from './greeting-voice-contract';
export {
  normalizeUtterance,
  CONSENT_PHRASES,
  consentHint,
  isConsentPhrase,
  CONFIRM_PHRASES,
  CANCEL_PHRASES,
  quickPendingAnswer,
  HELP_PHRASES,
  NAV_STEP_PHRASES,
  NAV_STEP_WORDS,
  NAV_STEP_PREFIXES,
  quickNavigationAnswer,
} from './greeting-voice-phrases';
export type { QuickNavigationIntent } from './greeting-voice-phrases';
export { REPLIES } from './greeting-voice-replies';
export {
  MODEL_ANSWER_KINDS,
  confidenceOf,
  normalizeModelAnswer,
  effectiveRegister,
  VOICE_NAME_MAX,
  VOICE_MESSAGE_MAX,
  isIsoCalendarDate,
  VOICE_CURRENT_FIELDS,
  overlayCurrentBrief,
  validateField,
  conflictingSessionFields,
  validateSessionField,
  checkCommand,
} from './greeting-voice-validate';
export type {
  ModelAnswerKind,
  ModelField,
  ModelAnswer,
  VoiceCurrentField,
  VoiceCurrent,
  FieldCheck,
  SessionFieldCheck,
} from './greeting-voice-validate';
export {
  VOICE_TRANSCRIPT_MAX,
  transcriptTooLong,
  sessionPromptLines,
  buildUnderstandPrompt,
} from './greeting-voice-prompt';

// ── Итог ────────────────────────────────────────────────────────────────

export interface ResolvedIntent {
  intent: VoiceIntent;
  confidence: number;
  reply: string | null;
  /**
   * K4: отказ, который помощник объясняет голосом (`speak` `refusal`).
   * Только когда он был: у прочих ответов поля нет вовсе.
   */
  refusal?: VoiceRefusalCode;
}

/** Код отказа — полем, только если он есть. */
function withRefusal(
  resolved: ResolvedIntent,
  code: VoiceRefusalCode | undefined,
): ResolvedIntent {
  return code ? { ...resolved, refusal: code } : resolved;
}

function joinReply(parts: Array<string | null | undefined>): string | null {
  const text = parts.filter((p): p is string => !!p).join(' ');
  return text || null;
}

/**
 * Ответ модели + реплика + состояние → интент и реплика помощника.
 *
 * Уточнение поверх карточки («нет, имя — Анна») возвращает ТОЛЬКО
 * исправленные поля: клиент сливает их с карточкой сам (`mergeFields` в
 * `frontend/src/lib/voice-confirm.ts`).
 */
export function resolveIntent(
  answer: ModelAnswer,
  transcript: string,
  ctx: VoiceUnderstandContext,
): ResolvedIntent {
  const loc = ctx.replyLocale;
  const t = REPLIES[loc];
  const unknown = (reply: string | null, confidence = answer.confidence) => ({
    intent: { kind: 'unknown' as const },
    confidence,
    reply,
  });

  // Карточка «я понял так» на экране: «согласен», «згоден», "I agree" —
  // ответ НА НЕЁ, а не согласие на генерацию (аудит волны K). Согласие
  // тратит деньги, и получать его побочно, подтверждая поле, нельзя.
  if (
    ctx.pending &&
    (isConsentPhrase(transcript) || answer.kind === 'consent')
  ) {
    return answer.confidence < FIELD_CONFIDENCE_MIN
      ? unknown(t.notUnderstood)
      : {
          intent: { kind: 'confirm' },
          confidence: answer.confidence,
          reply: null,
        };
  }

  // Согласие — ТОЛЬКО закрытый список и только с высокой уверенностью.
  // Модель сама по себе согласия не выдаёт: её `consent` без фразы из
  // списка — не согласие, а подсказка, как его сказать. И только когда
  // есть на что соглашаться: без собранного сценария генерировать нечего.
  if (isConsentPhrase(transcript) || answer.kind === 'consent') {
    if (!ctx.hasScript) return unknown(t.consentNeedsScript);
    if (!isConsentPhrase(transcript)) {
      return unknown(t.consentNeedsPhrase(consentHint(loc)));
    }
    if (answer.confidence < CONSENT_CONFIDENCE_MIN) {
      return unknown(t.consentUnsure(consentHint(loc)));
    }
    return {
      intent: { kind: 'consent', phrase: normalizeUtterance(transcript) },
      confidence: answer.confidence,
      reply: null,
    };
  }

  // K7 (§4А.7.4): «нет»/«отмена» ЦЕЛОЙ репликой без карточки «я понял
  // так» — ответ на сводку перед генерацией (кому, повод, цена): клиент
  // её закрывает. Сводка не уходит серверу как `pending` намеренно — иначе
  // «генерируй» стало бы подтверждением карточки, а не согласием. Отмена
  // ничего не меняет и не тратит, поэтому уверенность здесь не порог:
  // неверно расслышанная отмена стоит одного повтора фразы, а не денег.
  if (
    !ctx.pending &&
    CANCEL_PHRASES.includes(stripPolite(normalizeUtterance(transcript)))
  ) {
    return {
      intent: { kind: 'cancel' },
      confidence: answer.confidence,
      reply: null,
    };
  }

  if (answer.confidence < FIELD_CONFIDENCE_MIN) {
    const names = answer.fields.map((f) => fieldNameOf(loc, f.field));
    return unknown(names.length ? t.reask(names) : t.notUnderstood);
  }

  switch (answer.kind) {
    case 'confirm':
    case 'cancel':
      return ctx.pending
        ? {
            intent: { kind: answer.kind },
            confidence: answer.confidence,
            reply: null,
          }
        : unknown(t.notUnderstood);
    case 'help':
      return {
        intent: { kind: 'help' },
        confidence: answer.confidence,
        reply: null,
      };
    case 'navigate':
      return answer.to
        ? {
            intent: { kind: 'navigate', to: answer.to },
            confidence: answer.confidence,
            reply: null,
          }
        : unknown(t.notUnderstood);
    case 'command': {
      if (!answer.command) return unknown(t.notUnderstood);
      const check = checkCommand(answer.command, ctx);
      if (!check.ok) return withRefusal(unknown(check.reason), check.code);
      if (answer.command === 'other-music') {
        return resolveOtherMusic(answer.confidence, ctx);
      }
      return {
        intent: {
          kind: 'command',
          command: answer.command,
          ...(check.args ? { args: check.args } : {}),
        },
        confidence: answer.confidence,
        reply: null,
      };
    }
    case 'fill':
      return resolveFill(answer, ctx);
    case 'question':
      return resolveQuestion(answer, ctx);
    default:
      return unknown(t.notUnderstood);
  }
}

/**
 * «Другую музыку» (аудит волны K, B1) — не отдельный обработчик клиента,
 * а обычная карточка «я понял так» со списком `greeting-music-theme`:
 * СЛЕДУЮЩАЯ после текущей тема каталога, доступного поводу (витрина уже
 * отфильтрована сервисом музыки), по кругу. Применяется тем же путём,
 * что и «тема — Вальс», после «Да». Других тем нет — причина репликой.
 */
export function resolveOtherMusic(
  confidence: number,
  ctx: VoiceUnderstandContext,
): ResolvedIntent {
  const t = REPLIES[ctx.replyLocale];
  const name = SESSION_FIELD_NAMES[ctx.replyLocale].musicTheme;
  const unknown = (reply: string): ResolvedIntent => ({
    intent: { kind: 'unknown' },
    confidence,
    reply,
  });
  if (!sessionCardShown('musicTheme', ctx)) {
    return unknown(t.notOnScreen(name));
  }
  const m = ctx.session!.music!;
  const at = m.themes.findIndex((x) => x.id === m.selectedId);
  const next = [...m.themes.slice(at + 1), ...m.themes.slice(0, at + 1)].find(
    (x) => x.id !== m.selectedId,
  );
  if (!next) return unknown(t.noOtherMusic(name));
  return {
    intent: {
      kind: 'fill',
      fields: [
        {
          target: SESSION_FIELD_HOOKS.musicTheme.hook,
          value: next.id,
          label: SESSION_FIELD_NAMES[ctx.uiLocale].musicTheme,
        },
      ],
    },
    confidence,
    reply: t.confirmQuestion,
  };
}

/**
 * K4 (§4А.2 п.5): вопрос о шаге. Ответ — ТОЛЬКО из фактов состояния
 * (`ctx.answerQuestion` → `greetingAnswer` в `hint-facts.ts`), ни слова
 * от модели: она лишь узнала тему. Темы нет в закрытом списке или факта
 * нет — «не знаю, посмотрите справку» и `answered: false` (клиент
 * показывает кнопку справки), а не догадка.
 */
function resolveQuestion(
  answer: ModelAnswer,
  ctx: VoiceUnderstandContext,
): ResolvedIntent {
  const topic = answer.topic ?? null;
  const text =
    topic && ctx.answerQuestion
      ? ctx.answerQuestion(topic, ctx.replyLocale)
      : null;
  return {
    intent: { kind: 'question', topic, answered: !!text },
    confidence: answer.confidence,
    reply: text ?? REPLIES[ctx.replyLocale].questionUnknown,
  };
}

function resolveFill(
  answer: ModelAnswer,
  ctx: VoiceUnderstandContext,
): ResolvedIntent {
  const loc = ctx.replyLocale;
  const t = REPLIES[loc];
  const eff = effectiveOf(ctx.brief);
  // Карточка на экране — ещё не применённые, но уже показанные значения:
  // «тон — с юмором» после карточки «повод — соболезнование» проверяется
  // против соболезнования.
  for (const p of ctx.pending?.fields ?? []) {
    const f = briefFieldOf(p.target);
    if (f && typeof p.value === 'string') {
      const c = validateField(f, p.value, ctx, eff);
      if (c.ok) applyToEffective(eff, f, c.value);
    }
  }

  const unsure: string[] = [];
  const contradictions: string[] = [];
  const reasons: string[] = [];
  // K4: первый отказ, который помощник объясняет голосом (тон).
  let refusal: VoiceRefusalCode | undefined;
  const fields: VoiceField[] = [];
  const conflicted = conflictingSessionFields(answer.fields);
  const ordered = [...answer.fields].sort(
    (a, b) => orderOf(a.field) - orderOf(b.field),
  );
  for (const mf of ordered) {
    if (conflicted.has(mf.field)) {
      contradictions.push(fieldNameOf(loc, mf.field));
      continue;
    }
    if (mf.confidence < FIELD_CONFIDENCE_MIN) {
      unsure.push(fieldNameOf(loc, mf.field));
      continue;
    }
    const c = isSessionField(mf.field)
      ? validateSessionField(mf.field, mf.value, ctx)
      : typeof mf.value === 'string'
        ? validateField(mf.field, mf.value, ctx, eff)
        : ({ ok: false, reason: t.notUnderstood } as const);
    if (!c.ok) {
      reasons.push(c.reason);
      // Код отказа есть не у каждой ветки проверки: запасной ответ
      // «не понял» его не несёт, отсюда явное чтение поля.
      const code = (c as { code?: VoiceRefusalCode }).code;
      if (!refusal && code) refusal = code;
      continue;
    }
    if (!isSessionField(mf.field)) {
      applyToEffective(eff, mf.field, c.value as string);
    }
    fields.push({
      target: hookOf(mf.field),
      value: c.value,
      label: fieldNameOf(ctx.uiLocale, mf.field),
    });
  }

  const reply = joinReply([
    ...reasons,
    contradictions.length
      ? t.contradiction([...new Set(contradictions)])
      : null,
    unsure.length ? t.reask([...new Set(unsure)]) : null,
    fields.length ? t.confirmQuestion : null,
  ]);
  if (fields.length === 0) {
    return withRefusal(
      {
        intent: { kind: 'unknown' },
        confidence: answer.confidence,
        reply: reply ?? t.notUnderstood,
      },
      refusal,
    );
  }
  return withRefusal(
    {
      intent: { kind: 'fill', fields },
      confidence: answer.confidence,
      reply,
    },
    refusal,
  );
}
