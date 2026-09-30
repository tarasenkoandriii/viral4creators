/**
 * Голос переозвучки у поздравления — что показать в `RevoicePanel`
 * вместо выбора провайдера и голоса.
 *
 * Зачем отдельное правило. Панель переозвучки выбирала голос через
 * снимок брендбука (`PATCH /sessions/:id/brand-manifest`), а у
 * поздравления брендбука нет: голос живёт в `greetingBriefSnapshot`
 * (клон, пресет Grok или голос Soniox) и меняется только в мастере
 * поздравления (backend/src/modules/greeting-voice). Смена голоса на
 * экране «Постпрод» упиралась в 404. Поэтому для поздравления панель
 * голос не выбирает, а только называет текущий и ведёт в мастер;
 * переозвучка тем же голосом (и правка реплик) сервер принимает —
 * `postprod.service.ts` `reVoice()` читает голос из снимка брифа.
 *
 * Порядок проверки — тот же, что у `senderVoiceKind`
 * (lib/greeting-character.ts) и у `planWork` на бэкенде: клон, пресет,
 * Soniox. Снимок сервер держит взаимоисключающим, но при противоречивой
 * старой записи подпись должна назвать тот голос, что реально прозвучит.
 */

/** Какой голос поздравления прозвучит при переозвучке. */
export type GreetingRevoiceVoice =
  /** Свой клон отправителя; `label` — подпись, которую дал человек. */
  | { kind: 'clone'; label: string }
  /** Пресет xAI (модель говорит в кадре); имени в снимке нет — только id. */
  | { kind: 'preset'; voiceId: string }
  /** Голос Soniox; `label: null` — «голос Soniox по умолчанию». */
  | { kind: 'soniox'; label: string | null }
  /** Голос отправителя не выбран — звучит голос по умолчанию. */
  | { kind: 'default' };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * `null` — это не поздравление (есть снимок брендбука или нет снимка
 * брифа): панель работает как раньше, с выбором провайдера и голоса.
 * Иначе — голос поздравления для подписи.
 *
 * Брендбук побеждает: если он у сессии есть, `PATCH brand-manifest`
 * отработает, и прежний выбор голоса законен.
 */
export function greetingRevoiceVoice(facts: {
  hasBrandSnapshot: boolean;
  /** Сырой `session.greetingBriefSnapshot` — на фронте он `unknown`. */
  greetingBriefSnapshot: unknown;
}): GreetingRevoiceVoice | null {
  if (facts.hasBrandSnapshot) return null;
  const brief = asRecord(facts.greetingBriefSnapshot);
  if (!brief) return null;

  const clone = asRecord(brief.senderVoice);
  if (clone) {
    // Подпись клона обязательна на бэкенде, но пустая строка не должна
    // превратиться в пустую подпись — тогда хотя бы id голоса.
    const label =
      nonEmpty(clone.label) ??
      nonEmpty(clone.resembleVoiceId) ??
      nonEmpty(clone.userVoiceId);
    if (label) return { kind: 'clone', label };
  }
  const preset = nonEmpty(brief.presetVoiceId);
  if (preset) return { kind: 'preset', voiceId: preset };
  const soniox = asRecord(brief.sonioxVoice);
  if (soniox) {
    return {
      kind: 'soniox',
      label: nonEmpty(soniox.label) ?? nonEmpty(soniox.voiceId),
    };
  }
  return { kind: 'default' };
}

/** Строки подписи — раздел `revoicePanel` словаря. */
export interface GreetingVoiceCaptionLabels {
  /** «Свой голос: {label}». */
  greetingVoiceClone: string;
  /** «Голос ведущего Grok: {label}». */
  greetingVoicePreset: string;
  /** «Голос Soniox: {label}». */
  greetingVoiceSoniox: string;
  greetingVoiceSonioxDefault: string;
  greetingVoiceDefault: string;
}

/** Подпись текущего голоса поздравления под заголовком панели. */
export function greetingVoiceCaption(
  voice: GreetingRevoiceVoice,
  l: GreetingVoiceCaptionLabels
): string {
  switch (voice.kind) {
    case 'clone':
      return l.greetingVoiceClone.replace('{label}', voice.label);
    case 'preset':
      return l.greetingVoicePreset.replace('{label}', voice.voiceId);
    case 'soniox':
      return voice.label
        ? l.greetingVoiceSoniox.replace('{label}', voice.label)
        : l.greetingVoiceSonioxDefault;
    case 'default':
      return l.greetingVoiceDefault;
  }
}
