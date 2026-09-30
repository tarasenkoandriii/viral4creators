/**
 * Карточка «Сколько сцен» (фича №7) блока «Характер ролика».
 *
 * Вынесено из `GreetingVideoWizard.tsx` (файл перерос 3700 строк):
 * мастер держит только общий экран, степпер и загрузку сессии, а
 * каждый шаг живёт в своём файле, чтобы правка одного шага не
 * требовала листать остальные. Поведение и `data-qa` — без изменений.
 */

import { useState, useEffect, useCallback } from 'react';
import { Film } from 'lucide-react';
import { Card, CardHeader, Alert, Button } from '../../../components/ui';
import { useI18n } from '../../../lib/i18n-context';
import {
  greetingErrorMessage,
  getGreetingScenes,
  setGreetingScenes,
} from '../../../services/greeting-api';
import type { GreetingScenesView } from '../../../types/project';
import { HelpButton } from '../HelpSheet';
import { CardLoadError } from './CardLoadError';
import {
  SESSION_VOICE_TARGETS,
  planScenesVoice,
  refusalLines,
  saveEffect,
} from '../../../lib/voice-fields';
import { useVoiceFieldApplier } from '../../voice/voice-commands';
import {
  scenesSummary,
  lockedFieldRefusals,
} from '../../../lib/greeting-character';
import { useSessionVoiceTexts } from '../../voice/greeting-session-voice';

// ── Сколько сцен снимать (фича №7) ───────────────────────────────────────

/**
 * Один непрерывный кадр или несколько склеенных встык.
 *
 * Сцены описываются раскадровкой в одном промпте, и модель рендерит
 * их одним клипом с монтажными склейками — ровно так же, как это уже
 * делает товарная ветка. Ни цена, ни время ожидания от числа сцен не
 * меняются: вызов по-прежнему один.
 *
 * Показываем длительности: выбирая число сцен, человек вправе видеть
 * последствие выбора, а не узнавать его из готового ролика.
 */
export function ScenesStep({
  sessionId,
  onSummary,
  lockText = null,
}: {
  sessionId: string;
  onSummary?: (value: string | null) => void;
  /**
   * Карточка заперта (ролик готов или снимается): причина для голоса —
   * тот же отказ, что подпись на экране (`CharacterBlock`).
   */
  lockText?: string | null;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [view, setView] = useState<GreetingScenesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Первое чтение не прошло — карточка с причиной и «Повторить» (п. 10). */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    getGreetingScenes(sessionId)
      .then((v) => alive && setView(v))
      .catch((e: unknown) => {
        if (alive) setLoadError(greetingErrorMessage(e, dict));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- словарь: текст ошибки на момент сбоя
  }, [sessionId, attempt]);

  // Карточки нет, пока не загрузилась, — и в сводке её тоже нет.
  const summary = scenesSummary(view);
  useEffect(() => {
    onSummary?.(summary);
  }, [onSummary, summary]);

  /** @returns ошибку, показанную на экране, или `null` — сохранено (K5). */
  const choose = async (sceneCount: number): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      setView(await setGreetingScenes(sessionId, sceneCount));
      return null;
    } catch (e) {
      const message = greetingErrorMessage(e, dict);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  // Голос (K5): число сцен — тот же `choose(n)`, что у кнопки; число вне
  // 1…maxScenes — отказ (других кнопок на экране нет). Хук — до раннего
  // выхода: правило хуков; пока карточки нет, целей нет.
  const voiceTexts = useSessionVoiceTexts();
  useVoiceFieldApplier({
    targets: view ? [SESSION_VOICE_TARGETS.scenesCount] : [],
    describe: (f) =>
      typeof f.value !== 'string' || !/^\d+$/.test(f.value)
        ? String(f.value)
        : Number(f.value) === 1
          ? w.scenesOne
          : w.scenesMany.replace('{n}', String(Number(f.value))),
    apply: (fields) => {
      if (lockText)
        return lockedFieldRefusals(fields, voiceTexts.refusedField, lockText);
      const plan = planScenesVoice(view, busy, fields);
      const refusals = refusalLines(plan.refused, fields, voiceTexts);
      if (plan.count === null) return { refusals, effects: [] };
      return choose(plan.count).then((err) => ({
        refusals,
        effects: [saveEffect(err)],
      }));
    },
  });

  if (!view) {
    return loadError ? (
      <CardLoadError
        qa="greeting-scenes-card"
        icon={<Film size={18} />}
        title={w.scenesHeading}
        message={loadError}
        onRetry={retry}
      />
    ) : null;
  }

  const counts = Array.from({ length: view.maxScenes }, (_, i) => i + 1);

  return (
    <Card className="p-5" data-qa="greeting-scenes-card">
      <CardHeader
        icon={<Film size={18} />}
        title={w.scenesHeading}
        hint={w.scenesHint}
        action={<HelpButton cardHook="greeting-scenes-card" />}
      />

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <ul className="flex flex-wrap gap-2" data-qa="greeting-scenes-count">
        {counts.map((n) => (
          <li key={n}>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              active={view.sceneCount === n}
              onClick={() => void choose(n)}
            >
              {n === 1 ? w.scenesOne : w.scenesMany.replace('{n}', String(n))}
            </Button>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs text-silver-400">
        {view.sceneCount === 1
          ? w.scenesSingleNote
          : w.scenesSplitNote.replace(
              '{parts}',
              view.durations
                .map((d) => `${d}${w.musicSecondsSuffix}`)
                .join(' + ')
            )}
      </p>
    </Card>
  );
}
