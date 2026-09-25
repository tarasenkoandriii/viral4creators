/**
 * SceneTemplatePicker — пятая вкладка выбора источника сцены (этап 150,
 * TODO §III п.11).
 *
 * ## Почему вкладка, а не новый шаг мастера
 *
 * Шаг уже есть, и вопрос у него ровно тот же: откуда берётся сцена.
 * Четыре существующих ответа — библиотека, поиск, ссылка, файл — все
 * означают «чужой ролик»; приём это пятый ответ на тот же вопрос.
 * Отдельный шаг заводил бы вторую позицию степпера под тот же выбор и
 * ломал бы `readinessOfSession`, где пункт «откуда сцена» тоже один.
 *
 * ## Что показывается и чего не показывается
 *
 * Карточка — подпись, одна строка про то, чем приём держится, и число
 * кадров. Английские тексты приёмов (кадры, правила формата) НЕ
 * показываются: они писались для модели, и человеку в них нечего
 * читать — а перевод их на экран означал бы два источника правды о том,
 * что снимается.
 *
 * Оговорка про молчание — там и только там, где человек в кадре есть, а
 * говорить не будет (наша озвучка). Где лица нет вовсе, писать об этом
 * значило бы объяснять отсутствие того, чего не обещали.
 */

import { useEffect, useState } from 'react';
import { Check, Clapperboard, MicOff } from 'lucide-react';
import { Alert, Button, Spinner } from './ui';
import { useI18n } from '../lib/i18n-context';
import { errorMessage } from '../services/projects-api';
import {
  chooseSceneTemplate,
  getSceneTemplates,
  type SceneTemplateView,
} from '../services/scene-templates-api';
import { canChoose, templateCards } from '../lib/scene-templates';

export function SceneTemplatePicker({
  sessionId,
  disabled,
  onChange,
}: {
  sessionId: string | null;
  disabled: boolean;
  /**
   * Выбор изменился. Снятие сообщается так же, как выбор (аудит этапа
   * 150, А-3): мастер обязан знать, что источника сцены больше нет.
   */
  onChange: (templateId: string | null) => void;
}) {
  const { dict } = useI18n();
  const t = dict.sceneTemplates;
  const [view, setView] = useState<SceneTemplateView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Сессии ещё нет — она создаётся прямо сейчас. Это ожидание, а не
    // пустой каталог: показать «приёмов нет» там, где их просто не
    // успели спросить, значило бы соврать (аудит этапа 150, А-5).
    if (!sessionId) {
      setLoading(true);
      return;
    }
    setLoading(true);
    getSceneTemplates(sessionId)
      .then((fresh) => {
        if (alive) setView(fresh);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const choose = async (templateId: string | null) => {
    if (!sessionId) return;
    setBusy(templateId ?? '—');
    setError(null);
    try {
      const fresh = await chooseSceneTemplate(sessionId, templateId);
      setView(fresh);
      onChange(templateId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Spinner size={20} />;

  const cards = templateCards(view?.templates ?? [], view?.chosen ?? null, t);
  const selectable = canChoose(view) && !disabled;

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold">{t.title}</p>
        <p className="mt-1 text-xs leading-relaxed text-silver-400">{t.hint}</p>
      </div>

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Разобранный референс закрывает выбор — говорим это ДО нажатия,
          а не показываем отказ после.

          Обычный `Alert`, а не `LockedNote` (аудит этапа 150, А-2):
          `LockedNote` всегда рисует кнопку «Сравнить режимы» и ведёт на
          экран тарифов, а здесь ограничение к деньгам отношения не
          имеет — платить за его снятие некуда и незачем. */}
      {view && view.analysed && <Alert tone="info">{t.analysedNote}</Alert>}

      <div className="space-y-2">
        {cards.map((card) => (
          <div
            key={card.id}
            className={`rounded-xl border px-3 py-3 ${
              card.chosen
                ? 'border-accent bg-accent/10'
                : 'border-silver-300 dark:border-silver-700'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 text-sm font-medium">
                <Clapperboard size={14} className="shrink-0 text-accent" />
                {card.label}
              </span>
              <span className="shrink-0 text-[11px] text-silver-400">
                {t.beats.replace('{{n}}', String(card.beats))}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-silver-400">
              {card.hint}
            </p>
            {card.silent && (
              <p className="mt-1 flex items-start gap-1.5 text-xs text-silver-400">
                <MicOff size={12} className="mt-0.5 shrink-0" />
                {t.silentNote}
              </p>
            )}
            <div className="mt-2">
              {card.chosen ? (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-accent">
                    <Check size={12} />
                    {t.chosen}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busy === '—'}
                    disabled={!selectable || busy !== null}
                    onClick={() => void choose(null)}
                  >
                    {t.clear}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  loading={busy === card.id}
                  disabled={!selectable || busy !== null}
                  onClick={() => void choose(card.id)}
                >
                  {t.choose}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
