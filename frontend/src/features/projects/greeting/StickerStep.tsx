/**
 * Карточка «Наклейка поверх кадра» (фича №8) блока «Характер ролика».
 *
 * Вынесено из `GreetingVideoWizard.tsx` (файл перерос 3700 строк):
 * мастер держит только общий экран, степпер и загрузку сессии, а
 * каждый шаг живёт в своём файле, чтобы правка одного шага не
 * требовала листать остальные. Поведение и `data-qa` — без изменений.
 */

import { useState, useEffect, useCallback } from 'react';
import { Sticker } from 'lucide-react';
import { Card, CardHeader, Button, Alert, Input } from '../../../components/ui';
import { useI18n } from '../../../lib/i18n-context';
import {
  greetingErrorMessage,
  searchGreetingStickers,
  clearGreetingSticker,
  moveGreetingSticker,
  selectGreetingSticker,
} from '../../../services/greeting-api';
import {
  type GreetingStickerView,
  STICKER_PLACEMENTS,
} from '../../../types/project';
import { HelpButton } from '../HelpSheet';
import { CardLoadError } from './CardLoadError';
import {
  SESSION_VOICE_TARGETS,
  planStickerVoice,
  refusalLines,
  needsSave,
  saveEffect,
} from '../../../lib/voice-fields';
import { useVoiceFieldApplier } from '../../voice/voice-commands';
import {
  stickerCardHidden,
  stickerSummary,
  lockedFieldRefusals,
} from '../../../lib/greeting-character';
import {
  useSessionVoiceTexts,
  describeSessionValue,
} from '../../voice/greeting-session-voice';

// ── Наклейка поверх кадра (фича №8) ──────────────────────────────────────

/**
 * Поиск наклейки на Pixabay и её положение в кадре.
 *
 * Ссылка на источник показана у каждой находки не из вежливости:
 * условия API Pixabay требуют показывать, откуда картинки, всякий раз,
 * когда выдача отображается. Сама лицензия атрибуции не требует — это
 * разные документы, и обязывает нас первый.
 *
 * Скачивает картинку сервер, а не браузер: те же условия запрещают
 * постоянный хотлинк, поэтому в ролик уходит уже наша копия.
 */
export function StickerStep({
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
  const [view, setView] = useState<GreetingStickerView | null>(null);
  const [query, setQuery] = useState('');
  /**
   * Запрос, по которому показана выдача (CONTRACT6 G-FE п. 3). Сервер
   * берёт наклейку из кеша ЭТОГО запроса; раньше уходил текст поля —
   * человек искал «торт», дописывал «ы» и кликал по картинке из выдачи
   * «торт»: сервер искал её среди «торты» и отказывал.
   */
  const [resultsQuery, setResultsQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Первое чтение не прошло — карточка с причиной и «Повторить» (п. 10). */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    searchGreetingStickers(sessionId, '')
      .then((v) => {
        if (!alive) return;
        setView(v);
        setResultsQuery('');
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(greetingErrorMessage(e, dict));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- словарь: текст ошибки на момент сбоя
  }, [sessionId, attempt]);

  /** @returns ошибку, показанную на экране, или `null` — сохранено (K5). */
  const run = async (
    fn: () => Promise<GreetingStickerView>
  ): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      setView(await fn());
      return null;
    } catch (e) {
      const message = greetingErrorMessage(e, dict);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  // Нет ключа Pixabay и нечего снимать — карточки нет вовсе (хук
  // `greeting-sticker-card` объявляет это как `absentWhen`), и в сводке
  // её тоже нет: правило одно, `stickerCardHidden`. Запрос не прошёл —
  // `view` остаётся `null`, и сводка молчит, а не говорит «нет».
  const hidden = stickerCardHidden(view);
  const summary = stickerSummary(view, w);
  useEffect(() => {
    onSummary?.(summary);
  }, [onSummary, summary]);

  const placementLabels: Record<string, string> = {
    'top-left': w.stickerTopLeft,
    'top-right': w.stickerTopRight,
    'bottom-left': w.stickerBottomLeft,
    'bottom-right': w.stickerBottomRight,
    center: w.stickerCenter,
    full: w.stickerFull,
  };

  // Кнопки карточки и голос (K5) — одни и те же обработчики.
  const clear = () => run(() => clearGreetingSticker(sessionId));
  const move = (placement: string) =>
    run(() => moveGreetingSticker(sessionId, placement));

  // Голос (K5): место — тот же `move`, «без наклейки» — тот же `clear`,
  // строка поиска — то же поле (без запуска поиска: выдачу сервер разбора
  // не видит, картинку выбирают руками). Под запретом регистра — отказ
  // той же строкой, что на экране. Хук — до раннего выхода.
  const voiceTexts = useSessionVoiceTexts();
  const onScreen = !!view && !hidden;
  useVoiceFieldApplier({
    targets: onScreen
      ? [
          SESSION_VOICE_TARGETS.stickerQuery,
          SESSION_VOICE_TARGETS.stickerPlacement,
          SESSION_VOICE_TARGETS.stickerEnabled,
        ]
      : [],
    describe: (f) =>
      f.target === SESSION_VOICE_TARGETS.stickerPlacement &&
      typeof f.value === 'string'
        ? (placementLabels[f.value] ?? f.value)
        : describeSessionValue(f.value, dict.voiceFields),
    apply: (fields) => {
      if (lockText)
        return lockedFieldRefusals(fields, voiceTexts.refusedField, lockText);
      const plan = planStickerVoice(
        onScreen && view
          ? {
              selected: view.selected,
              configured: view.configured,
              allowed: view.allowed !== false,
            }
          : null,
        busy,
        fields
      );
      if (plan.query !== undefined) setQuery(plan.query);
      const refusals = refusalLines(plan.refused, fields, voiceTexts);
      // Строка поиска ждёт кнопку «Найти»; место и «убрать» сохраняет
      // тот же обработчик, что у кнопок, — ждём его ответа.
      const typed =
        plan.query !== undefined ? [needsSave(w.stickerSearch)] : [];
      const saving =
        plan.action?.kind === 'clear'
          ? clear()
          : plan.action?.kind === 'move'
            ? move(plan.action.placement)
            : null;
      if (!saving) return { refusals, effects: typed };
      return saving.then((err) => ({
        refusals,
        effects: [saveEffect(err), ...typed],
      }));
    },
  });

  if (!view) {
    return loadError ? (
      <CardLoadError
        qa="greeting-sticker-card"
        icon={<Sticker size={18} />}
        title={w.stickerHeading}
        message={loadError}
        onRetry={retry}
      />
    ) : null;
  }
  if (hidden) return null;
  // У торжественных, деликатных и траурных поводов наклеек нет (сервер
  // откажет в выборе): поиск картинок нельзя ограничить настроением.
  // Этап D: карточка не пропадает молча, а объясняет почему — пустое
  // место на месте знакомой секции выглядит поломкой. Уже выбранную
  // раньше наклейку показываем — её нужно иметь возможность снять.
  const stickersAllowed = view.allowed !== false;

  return (
    <Card className="p-5" data-qa="greeting-sticker-card">
      <CardHeader
        icon={<Sticker size={18} />}
        title={w.stickerHeading}
        hint={w.stickerHint}
        action={
          <>
            <HelpButton cardHook="greeting-sticker-card" />
            {view.selected && (
              // Галочка «наклейка» (K5): «выключить» — эта же кнопка.
              <Button
                data-qa="greeting-sticker-enabled"
                size="sm"
                variant="ghost"
                loading={busy}
                onClick={() => void clear()}
              >
                {w.stickerClear}
              </Button>
            )}
          </>
        }
      />

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {view.selected && (
        <div className="mb-3 flex items-center gap-3 rounded-xl border border-silver-200/70 p-3 dark:border-silver-800">
          <img
            src={view.selected.url}
            alt=""
            className="h-14 w-14 shrink-0 object-contain"
          />
          <div className="min-w-0">
            <p className="text-xs text-silver-400">{w.stickerPicked}</p>
            <ul
              className="mt-1.5 flex flex-wrap gap-1.5"
              data-qa="greeting-sticker-placement"
            >
              {STICKER_PLACEMENTS.map((placement) => (
                <li key={placement}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    active={view.selected?.placement === placement}
                    onClick={() => void move(placement)}
                  >
                    {placementLabels[placement]}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {!stickersAllowed && (
        <p className="text-xs text-silver-400">{w.stickerUnavailable}</p>
      )}

      {view.configured && stickersAllowed && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              data-qa="greeting-sticker-query"
              value={query}
              onChange={(e) => setQuery(e.target.value.slice(0, 100))}
              placeholder={w.stickerSearchPlaceholder}
              disabled={busy}
            />
            <Button
              size="sm"
              loading={busy}
              disabled={!query.trim()}
              onClick={() => {
                const q = query.trim();
                void run(async () => {
                  const next = await searchGreetingStickers(sessionId, q);
                  setResultsQuery(q);
                  return next;
                });
              }}
            >
              {w.stickerSearch}
            </Button>
          </div>

          {view.results.length > 0 && (
            <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {view.results.map((r) => (
                <li key={r.id} className="text-center">
                  <button
                    type="button"
                    disabled={busy}
                    className="block w-full rounded-xl border border-silver-200/70 p-2 hover:border-sky-400 disabled:opacity-50 dark:border-silver-800"
                    onClick={() =>
                      void run(() =>
                        selectGreetingSticker(sessionId, resultsQuery, r.id)
                      )
                    }
                  >
                    <img
                      src={r.previewUrl}
                      alt={r.tags}
                      className="mx-auto h-16 w-16 object-contain"
                    />
                  </button>
                  {/* Требование условий API, а не вежливость. */}
                  <a
                    href={r.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 block text-[10px] text-silver-400 underline"
                  >
                    Pixabay
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
