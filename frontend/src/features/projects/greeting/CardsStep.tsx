/**
 * Карточка «Титры»: титульная и закрывающая (фичи №38/№39) блока
 * «Характер ролика».
 *
 * Вынесено из `GreetingVideoWizard.tsx` (файл перерос 3700 строк):
 * мастер держит только общий экран, степпер и загрузку сессии, а
 * каждый шаг живёт в своём файле, чтобы правка одного шага не
 * требовала листать остальные. Поведение и `data-qa` — без изменений.
 */

import { useState, useEffect, useId, useCallback } from 'react';
import { Type } from 'lucide-react';
import {
  Card,
  CardHeader,
  Alert,
  Field,
  Input,
  Button,
} from '../../../components/ui';
import { useI18n } from '../../../lib/i18n-context';
import {
  greetingErrorMessage,
  getGreetingCards,
  updateGreetingCards,
  MAX_GREETING_CARD_LENGTH,
} from '../../../services/greeting-api';
import type { GreetingCardsView } from '../../../types/project';
import { HelpButton } from '../HelpSheet';
import { CardLoadError } from './CardLoadError';
import {
  SESSION_VOICE_TARGETS,
  planCardsVoice,
  refusalLines,
  cardsVoiceSave,
  saveEffect,
} from '../../../lib/voice-fields';
import { useVoiceFieldApplier } from '../../voice/voice-commands';
import {
  cardsSummary,
  lockedFieldRefusals,
} from '../../../lib/greeting-character';
import {
  useSessionVoiceTexts,
  describeSessionValue,
} from '../../voice/greeting-session-voice';

// ── Карточки: титульная и закрывающая (фичи №38/№39) ─────────────────────

/**
 * Две подписи поверх кадра: в начале и в конце.
 *
 * Титульная НЕ подставляется сама, хотя имя получателя у нас есть:
 * она называет его в первую же секунду, а половина поздравлений —
 * сюрприз. Предупреждение стоит рядом, подставить заготовку можно в
 * один клик — но это решение отправителя, а не наше.
 */
export function CardsStep({
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
  const [view, setView] = useState<GreetingCardsView | null>(null);
  const [title, setTitle] = useState('');
  const [closing, setClosing] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Первое чтение не прошло — карточка с причиной и «Повторить» (п. 10). */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const fid = useId();

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    getGreetingCards(sessionId)
      .then((v) => {
        if (!alive) return;
        setView(v);
        setTitle(v.cards.title ?? '');
        setClosing(v.cards.closing ?? '');
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(greetingErrorMessage(e, dict));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- словарь: текст ошибки на момент сбоя
  }, [sessionId, attempt]);

  /**
   * Значения — явным аргументом, а не из замыкания: голос (K5) кладёт
   * текст в поле и сразу сохраняет, а `setTitle` до следующего рендера
   * замыкание не обновит. Кнопка зовёт с текущими полями.
   *
   * `keep` — поле, набранное руками и НЕ сохранённое, которое голос не
   * трогал: ответ сервера его не перезаписывает (в сервер ушло прежнее
   * сохранённое значение, `cardsVoiceSave`).
   *
   * @returns ошибку, показанную на экране, или `null` — сохранено (K5).
   */
  const save = async (
    values = { title, closing },
    keep: { title: boolean; closing: boolean } = {
      title: false,
      closing: false,
    }
  ): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      const next = await updateGreetingCards(sessionId, {
        title: values.title.trim() || null,
        closing: values.closing.trim() || null,
      });
      setView(next);
      if (!keep.title) setTitle(next.cards.title ?? '');
      if (!keep.closing) setClosing(next.cards.closing ?? '');
      setSaved(true);
      return null;
    } catch (e) {
      const message = greetingErrorMessage(e, dict);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  // Голос (K5): текст — в те же поля, что `onChange` (тот же потолок),
  // затем то же «Сохранить». Пустая строка — убрать титр, как стёртое
  // руками поле. Хук — до раннего выхода.
  const voiceTexts = useSessionVoiceTexts();
  useVoiceFieldApplier({
    targets: view
      ? [SESSION_VOICE_TARGETS.cardsTitle, SESSION_VOICE_TARGETS.cardsClosing]
      : [],
    describe: (f) => describeSessionValue(f.value, dict.voiceFields),
    apply: (fields) => {
      if (lockText)
        return lockedFieldRefusals(fields, voiceTexts.refusedField, lockText);
      const plan = planCardsVoice(!!view, busy, fields);
      const refusals = refusalLines(plan.refused, fields, voiceTexts);
      const s = cardsVoiceSave(plan, view?.cards ?? null);
      if (!s) return { refusals, effects: [] };
      // В поле — только продиктованное; второе поле остаётся как набрано
      // руками, а в сервер уходит его СОХРАНЁННОЕ значение.
      if (plan.title !== undefined) setTitle(plan.title);
      if (plan.closing !== undefined) setClosing(plan.closing);
      setSaved(false);
      return save(s.values, s.keep).then((err) => ({
        refusals,
        effects: [saveEffect(err)],
      }));
    },
  });

  // По сохранённому, а не по набранному: сводка — о том, что уйдёт в ролик.
  const summary = cardsSummary(view?.cards ?? null, w);
  useEffect(() => {
    onSummary?.(summary);
  }, [onSummary, summary]);

  if (!view) {
    return loadError ? (
      <CardLoadError
        qa="greeting-cards-card"
        icon={<Type size={18} />}
        title={w.cardsHeading}
        message={loadError}
        onRetry={retry}
      />
    ) : null;
  }

  const dirty =
    title.trim() !== (view.cards.title ?? '') ||
    closing.trim() !== (view.cards.closing ?? '');

  return (
    <Card className="p-5" data-qa="greeting-cards-card">
      <CardHeader
        icon={<Type size={18} />}
        title={w.cardsHeading}
        hint={w.cardsHint}
        action={<HelpButton cardHook="greeting-cards-card" />}
      />

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <div className="space-y-3">
        <Field
          label={w.cardsTitleLabel}
          hint={w.cardsTitleHint}
          htmlFor={`${fid}-title`}
        >
          {/* Титры пишет человек, подсказка собрана из брифа с именем —
              личный текст, на кадре лендинга размывается (этап I ТЗ
              Greeting 2.0, §5.3). */}
          <Input
            id={`${fid}-title`}
            data-qa="greeting-cards-title"
            data-qa-mask="personal-card-title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value.slice(0, MAX_GREETING_CARD_LENGTH));
              setSaved(false);
            }}
            placeholder={view.suggested.title ?? ''}
            disabled={busy}
          />
        </Field>
        {!title && view.suggested.title && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setTitle(view.suggested.title ?? '');
              setSaved(false);
            }}
            // Подсказка титра собрана из брифа и несёт имя получателя.
            data-qa-mask="personal-card-suggestion"
          >
            {w.cardsUseSuggestion.replace('{text}', view.suggested.title)}
          </Button>
        )}

        <Field
          label={w.cardsClosingLabel}
          hint={w.cardsClosingHint}
          htmlFor={`${fid}-closing`}
        >
          <Input
            id={`${fid}-closing`}
            data-qa="greeting-cards-closing"
            data-qa-mask="personal-card-closing"
            value={closing}
            onChange={(e) => {
              setClosing(e.target.value.slice(0, MAX_GREETING_CARD_LENGTH));
              setSaved(false);
            }}
            placeholder={view.suggested.closing ?? ''}
            disabled={busy}
          />
        </Field>
        {!closing && view.suggested.closing && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setClosing(view.suggested.closing ?? '');
              setSaved(false);
            }}
            data-qa-mask="personal-card-suggestion"
          >
            {w.cardsUseSuggestion.replace('{text}', view.suggested.closing)}
          </Button>
        )}

        <Button
          size="sm"
          loading={busy}
          disabled={!dirty}
          onClick={() => void save()}
        >
          {saved && !dirty ? w.cardsSaved : w.cardsSave}
        </Button>
      </div>
    </Card>
  );
}
