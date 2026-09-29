/**
 * Справка по карточке мастера: сначала объяснение, ролик — по кнопке
 * (29.09.2026, §11-септдециес `docs-tz/TZ-Tutorial-Video-Voiced.md`).
 *
 * ## Почему сначала текст, а не сразу ролик
 *
 * Человек нажал (i) посреди работы. Автозапуск видео в этот момент —
 * звук поверх того, чем он занят, и полминуты ожидания вместо ответа.
 * Текст отвечает сразу; ролик показывается тому, кому текста не хватило.
 *
 * Ровно та же раскладка достаётся голосовому управлению (§4А.7.3 ТЗ
 * поздравления): слово «помощь» открывает ЭТОТ лист, а не запускает
 * звук поверх голоса человека.
 *
 * ## Почему справка живёт без ролика
 *
 * Ролик появляется у темы не сразу: он собирается ночью и показывается
 * только после вычитки оператором. До тех пор кнопка (i) обязана
 * работать — с текстом и честной строкой о том, что ролика пока нет.
 *
 * Раскладка листа — как у `ConfirmDialog` и `SketchSheet`: на телефоне
 * нижний лист, на десктопе модалка.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Info, X } from 'lucide-react';
import { Alert, Button, Card, Spinner } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { helpTopicOf } from '../../lib/greeting-help';
import { HelpContext, useHelp } from './help-context';
import {
  getTutorialHelp,
  type TutorialHelpView,
} from '../../services/tutorial-help-api';

/** Провайдер вместе с самим листом: один лист на весь мастер. */
export function HelpProvider({ children }: { children: ReactNode }) {
  const [topic, setTopic] = useState<string | null>(null);
  const open = useCallback((t: string) => setTopic(t), []);
  const close = useCallback(() => setTopic(null), []);
  const value = useMemo(() => open, [open]);
  return (
    <HelpContext.Provider value={value}>
      {children}
      <HelpSheet topic={topic} onClose={close} />
    </HelpContext.Provider>
  );
}

/** Кнопка (i) в правый верхний угол карточки (`CardHeader action`). */
export function HelpButton({ cardHook }: { cardHook: string }) {
  const { dict } = useI18n();
  const onOpen = useHelp();
  const topic = helpTopicOf(cardHook);
  // Нет темы — нет кнопки. Кнопка, ведущая в пустоту, хуже отсутствия
  // кнопки: человек нажимает её ещё раз, думая, что промахнулся.
  if (!topic || !onOpen) return null;
  return (
    <button
      type="button"
      data-qa={`${cardHook}-help`}
      aria-label={dict.tutorialHelp.button}
      title={dict.tutorialHelp.button}
      onClick={() => onOpen(topic)}
      className="flex h-9 w-9 items-center justify-center rounded-full text-silver-400 hover:bg-silver-100 hover:text-silver-600 dark:hover:bg-silver-800 dark:hover:text-silver-200"
    >
      <Info size={18} />
    </button>
  );
}

function HelpSheet({
  topic,
  onClose,
}: {
  /** `null` — лист закрыт. */
  topic: string | null;
  onClose: () => void;
}) {
  const { dict } = useI18n();
  const sheetRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<TutorialHelpView | null>(null);
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!topic) return;
    let alive = true;
    setView(null);
    setError(false);
    setPlaying(false);
    void getTutorialHelp(topic)
      .then((v) => alive && setView(v))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [topic]);

  // Esc закрывает, начальный фокус — на первой кнопке листа: тот же
  // разбор, что у `ConfirmDialog`, и по той же причине — без него фокус
  // клавиатуры остаётся под затемнением.
  useEffect(() => {
    if (!topic) return;
    sheetRef.current
      ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [topic, onClose]);

  if (!topic) return null;

  return (
    <div
      role="presentation"
      ref={sheetRef}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 backdrop-blur-sm animate-fadeIn sm:items-center"
      onClick={onClose}
    >
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-sheet-title"
        className="w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start gap-3">
          <h2 id="help-sheet-title" className="flex-1 text-lg font-medium">
            {view?.title ?? dict.tutorialHelp.title}
          </h2>
          <button
            type="button"
            aria-label={dict.tutorialHelp.close}
            onClick={onClose}
            className="shrink-0 text-silver-400 hover:text-silver-600"
          >
            <X size={18} />
          </button>
        </div>

        {error && <Alert tone="error">{dict.tutorialHelp.failed}</Alert>}
        {!view && !error && <Spinner />}

        {view && (
          <>
            <p className="whitespace-pre-line text-sm text-silver-600 dark:text-silver-300">
              {view.text}
            </p>
            {view.videoUrl ? (
              playing ? (
                <video
                  data-qa="tutorial-help-video"
                  className="mt-4 w-full rounded-xl"
                  src={view.videoUrl}
                  controls
                  autoPlay
                />
              ) : (
                <Button
                  className="mt-4"
                  data-qa="tutorial-help-play"
                  onClick={() => setPlaying(true)}
                >
                  {dict.tutorialHelp.watch}
                </Button>
              )
            ) : (
              // Не ошибка и не пустота: ролик собирается ночью и
              // показывается после вычитки. Сказать об этом честно
              // дешевле, чем прятать кнопку и оставлять человека гадать.
              <p className="mt-4 text-xs text-silver-400">
                {dict.tutorialHelp.notReady}
              </p>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
