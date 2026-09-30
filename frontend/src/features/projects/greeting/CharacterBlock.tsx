/**
 * Блок «Характер ролика» — пять карточек настройки (голос, музыка, титры,
 * наклейка, сцены) одной группой со сводкой сверху.
 *
 * Вынесено из `GreetingVideoWizard.tsx` (файл перерос 3700 строк):
 * мастер держит только общий экран, степпер и загрузку сессии, а
 * каждый шаг живёт в своём файле, чтобы правка одного шага не
 * требовала листать остальные. Поведение и `data-qa` — без изменений.
 */

import { useState, useMemo, useCallback, useRef } from 'react';
import { useI18n } from '../../../lib/i18n-context';
import type { GreetingBriefView } from '../../../types/project';
import { useGreetingPolicy } from '../../../lib/useGreetingPolicy';
import { rulesOf } from '../../../lib/greeting-policy';
import {
  type CharacterSummary,
  type CharacterPart,
  characterRegister,
  characterSummaryLine,
  characterLockOf,
  type SenderVoiceKind,
} from '../../../lib/greeting-character';

/** Выбранный голос для шага «Видео»; поля `null` — не прочитаны. */
export interface SelectedVoice {
  label: string | null;
  kind: SenderVoiceKind | null;
}
import { Alert } from '../../../components/ui';
import { greetingVoiceLanguage } from '../../../lib/tts-provider-choice';
import { SenderVoiceStep } from './SenderVoiceStep';
import { MusicThemeStep } from './MusicThemeStep';
import { CardsStep } from './CardsStep';
import { StickerStep } from './StickerStep';
import { ScenesStep } from './ScenesStep';

// ── Характер ролика: пять карточек одной группой (этап D, §3.3) ──────────

/**
 * Голос, музыка, титры, наклейка и сцены — одна группа «настройте
 * ролик»: у них и тема справки одна (`greeting-help.ts`). Сводка сверху
 * отвечает «что уже выбрано», не заставляя листать пять карточек.
 *
 * Карточки НЕ сворачиваются: их `data-qa` — хуки сценариев обучалки,
 * и хук, спрятанный за раскрытием, упал бы на `assertVisible`. Шагом
 * степпера блок тоже не становится — степпер остаётся из четырёх.
 *
 * Правила регистра (предупреждение о своей музыке) — по серверной
 * таблице `GET /greeting/policy`; не загрузилась — предупреждений нет,
 * своих правил интерфейс не выдумывает.
 */
export function CharacterBlock({
  sessionId,
  stepKey,
  brief,
  videoStatus = null,
  onVoice,
}: {
  sessionId: string;
  /** Ключ пересоздания карточек: новая версия сессии — новое состояние. */
  stepKey: string;
  brief: Pick<
    GreetingBriefView,
    'occasion' | 'occasionRegister' | 'scriptLanguage'
  >;
  /** Статус ролика сессии: готов или снимается — карточки заперты. */
  videoStatus?: string | null;
  /**
   * Выбранный голос для шага «Видео» (S2): подпись — та же, что в сводке
   * (её показывает карточка согласия K7), вид — для плашки «озвучка не
   * легла». `null` — не прочитан.
   */
  onVoice?: (voice: SelectedVoice) => void;
}) {
  const { dict, locale } = useI18n();
  const w = dict.greetingVideoWizard;
  // Та же таблица, что у брифа, через общий хук: второй копии загрузки
  // (и второго толкования «не загрузилась») у экрана быть не должно.
  const policy = useGreetingPolicy();
  const [summary, setSummary] = useState<CharacterSummary>({});

  // Колбэки стабильны: карточки сообщают сводку из эффекта, и новая
  // функция на каждый рендер гоняла бы этот эффект впустую.
  const report = useMemo(() => {
    const one = (part: CharacterPart) => (value: string | null) =>
      setSummary((prev) =>
        prev[part] === value ? prev : { ...prev, [part]: value }
      );
    return {
      voice: one('voice'),
      music: one('music'),
      cards: one('cards'),
      sticker: one('sticker'),
      scenes: one('scenes'),
    };
  }, []);

  // Голос уходит и в сводку блока, и наверх — шагу «Видео». Подпись и
  // вид приходят из двух эффектов карточки, поэтому копятся в ref и
  // уходят наверх вместе.
  const voiceRef = useRef<SelectedVoice>({ label: null, kind: null });
  const reportVoice = useCallback(
    (label: string | null) => {
      report.voice(label);
      voiceRef.current = { ...voiceRef.current, label };
      onVoice?.(voiceRef.current);
    },
    [report, onVoice]
  );
  const reportVoiceKind = useCallback(
    (kind: SenderVoiceKind | null) => {
      voiceRef.current = { ...voiceRef.current, kind };
      onVoice?.(voiceRef.current);
    },
    [onVoice]
  );

  const rules = rulesOf(policy, characterRegister(policy, brief));
  const line = characterSummaryLine(summary, w);
  // Проверочный аудит CONTRACT6: у готового ролика карточки правились на
  // месте и меняли снимок уже врученного ролика, а нового рендера та же
  // сессия не даёт. Готов — заперто с выходом «правьте бриф или текст»;
  // снимается — заперто до конца рендера. Голос — тот же отказ.
  const lock = characterLockOf(videoStatus);
  const lockText =
    lock === 'done'
      ? dict.greetingUi.characterLockedDone
      : lock === 'busy'
        ? dict.greetingUi.videoBusyEditHint
        : null;

  return (
    <section className="space-y-4" data-qa="greeting-character-block">
      <div>
        <h2 className="text-base font-semibold">{w.characterHeading}</h2>
        <p className="mt-0.5 text-xs text-silver-400">{w.characterHint}</p>
        {/* Сводка повторяет подпись своего голоса и титры — личный
            текст; на кадре лендинга размывается (этап I ТЗ Greeting 2.0). */}
        {line && (
          <p className="mt-2 text-sm" data-qa-mask="personal-character-summary">
            {line}
          </p>
        )}
        {lockText && (
          <Alert tone="info" className="mt-2">
            {lockText}
          </Alert>
        )}
      </div>
      {/* `fieldset disabled` гасит все кнопки и поля пяти карточек разом
          (включая кнопки внутри `MyVoicesSection`), не трогая их
          `data-qa`: хуки обучалки остаются на месте. */}
      <fieldset
        disabled={!!lock}
        aria-disabled={!!lock}
        className="m-0 min-w-0 space-y-4 border-0 p-0"
      >
        {/* Ключ у каждой карточки свой, с общим префиксом версии сессии:
          пять братьев с ОДНИМ ключом — это дубликат, на который React
          ругается и при смене версии может потерять или задвоить
          карточку, а её `data-qa` — хук сценария обучалки. */}
        <SenderVoiceStep
          key={`${stepKey}:voice`}
          sessionId={sessionId}
          language={greetingVoiceLanguage(brief.scriptLanguage, locale)}
          onSummary={reportVoice}
          onVoiceKind={reportVoiceKind}
          lockText={lockText}
        />
        <MusicThemeStep
          key={`${stepKey}:music`}
          sessionId={sessionId}
          rules={rules}
          onSummary={report.music}
          lockText={lockText}
        />
        <CardsStep
          key={`${stepKey}:cards`}
          sessionId={sessionId}
          onSummary={report.cards}
          lockText={lockText}
        />
        <StickerStep
          key={`${stepKey}:sticker`}
          sessionId={sessionId}
          onSummary={report.sticker}
          lockText={lockText}
        />
        <ScenesStep
          key={`${stepKey}:scenes`}
          sessionId={sessionId}
          onSummary={report.scenes}
          lockText={lockText}
        />
      </fieldset>
    </section>
  );
}
