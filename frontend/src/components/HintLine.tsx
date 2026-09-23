/**
 * Строка совета под степпером — «Тонкая красная линия» §5.11, этапы 6–7.
 *
 * Правила поведения живут в `lib/hint-line.ts` и проверяются без
 * React; здесь остаются только три вещи, которых в чистой функции быть
 * не может: таймер простоя, сетевой вызов с отменой и отрисовка.
 *
 * ## Что здесь сделано нарочно
 *
 * 1. **Высота строки не меняется в момент загрузки.** Спиннер встаёт на
 *    место шеврона, а не добавляется рядом: подмена высоты заставляет
 *    содержимое под строкой прыгать, и человек теряет место, где читал.
 * 2. **Уход с шага и снятие галочки отменяют запрос в полёте.** Иначе
 *    ответ приезжает на экран, которого уже нет, — и совет оказывается
 *    не про то, что человек видит. Машина состояний роняет такой ответ
 *    и сама, но отмена ещё и не даёт за него платить дважды.
 * 3. **Ошибка не краснеет.** Строка сворачивается обратно. Совет —
 *    украшение пути, а не сам путь: плашка поверх мастера из-за
 *    неотвеченной подсказки несоразмерна поводу.
 * 4. **Подписи кнопок берутся из словаря и роутера, а не из ответа.**
 *    Модель называет только идентификатор (§5.7) — и незнакомый
 *    идентификатор здесь просто не рисуется, молча.
 */

import { useEffect, useReducer } from 'react';
import { ChevronRight, Lightbulb } from 'lucide-react';
import { Spinner } from './ui';
import { useI18n } from '../lib/i18n-context';
import { routes } from '../lib/router';
import {
  HINT_IDLE_MS,
  hintReducer,
  initialHintState,
  isVisible,
} from '../lib/hint-line';
import { requestWizardHint } from '../services/wizard-guide-api';
import type { GuideAction } from '../types';

/** Слаг документа → ключ словаря. Список закрыт на сервере (§5.7). */
const DOC_KEYS: Record<string, 'offer' | 'termsOfUse'> = {
  offer: 'offer',
  'terms-of-use': 'termsOfUse',
};

export function HintLine({
  projectId,
  stepId,
  enabled,
  stepLabels,
  onGoToStep,
}: {
  projectId: string;
  /** Текущий шаг мастера — он же часть ключа кеша на сервере. */
  stepId: string;
  /** Галочка стоит И фича включена оператором. */
  enabled: boolean;
  /** Подписи шагов — те же, что в степпере; из них собираются кнопки. */
  stepLabels: Record<string, string>;
  onGoToStep: (stepId: string) => void;
}) {
  const { dict, locale } = useI18n();
  const t = dict.wizardGuide;
  const [state, dispatch] = useReducer(
    hintReducer,
    initialHintState(enabled, stepId)
  );

  useEffect(() => {
    dispatch(enabled ? { type: 'enabled' } : { type: 'disabled' });
  }, [enabled]);

  useEffect(() => {
    dispatch({ type: 'step', stepId });
  }, [stepId]);

  // Простой на шаге. Таймер живёт только в свёрнутом состоянии: из
  // остальных событие всё равно ничего не меняет, а лишний таймер
  // пришлось бы помнить и гасить.
  useEffect(() => {
    if (state.phase !== 'collapsed') return;
    const id = setTimeout(() => dispatch({ type: 'idle' }), HINT_IDLE_MS);
    return () => clearTimeout(id);
  }, [state.phase, state.stepId]);

  useEffect(() => {
    if (state.phase !== 'loading') return;
    const ctl = new AbortController();
    let alive = true;
    requestWizardHint(projectId, { stepId, locale }, ctl.signal)
      .then((res) => {
        if (!alive) return;
        dispatch({
          type: 'result',
          hint: res.hint,
          actions: res.actions ?? [],
          notice: res.notice,
        });
      })
      .catch(() => {
        // Таймаут, 429, отказ модели — для человека это одно и то же:
        // строка сворачивается, повтор возможен.
        if (alive) dispatch({ type: 'failed' });
      });
    return () => {
      alive = false;
      ctl.abort();
    };
  }, [state.phase, state.stepId, projectId, stepId, locale]);

  if (!isVisible(state)) return null;

  const busy = state.phase === 'loading';
  const open = state.phase === 'shown' || state.phase === 'frozen';

  const header = (
    <span className="flex items-center gap-2 text-sm">
      <Lightbulb size={14} className="text-accent shrink-0" />
      <span className="font-medium">{t.title}</span>
      {!open &&
        (busy ? (
          <Spinner size={14} />
        ) : (
          <ChevronRight size={14} className="text-[var(--muted)]" />
        ))}
    </span>
  );

  return (
    <div className="mb-3 rounded-lg border border-[var(--border)] p-3">
      {open ? (
        header
      ) : (
        <button
          type="button"
          className="w-full text-left"
          aria-busy={busy}
          aria-label={busy ? t.loading : t.title}
          onClick={() => dispatch({ type: 'open' })}
        >
          {header}
        </button>
      )}

      {open && (
        <div className="mt-2 space-y-2">
          {state.hint && <p className="text-sm">{state.hint}</p>}
          {state.notice && (
            <p className="text-sm text-[var(--muted)]">{state.notice}</p>
          )}
          <HintActions
            actions={state.actions}
            stepLabels={stepLabels}
            docLabels={t.docs}
            gotoTemplate={t.gotoStep}
            openTemplate={t.openDoc}
            onGoToStep={onGoToStep}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Кнопки под советом (§5.7, этап 7).
 *
 * Действие, для которого нет подписи, не рисуется. Сервер уже отбросил
 * то, чего не бывает; здесь отсекается второй случай — шаг существует,
 * но мастер на этом экране его не показывает (обучалка нумерует раунды
 * записи лентой, а не степпером). Кнопка, ведущая в невидимое место,
 * хуже её отсутствия — тот же принцип, что на сервере.
 */
function HintActions({
  actions,
  stepLabels,
  docLabels,
  gotoTemplate,
  openTemplate,
  onGoToStep,
}: {
  actions: GuideAction[];
  stepLabels: Record<string, string>;
  docLabels: Record<'offer' | 'termsOfUse', string>;
  gotoTemplate: string;
  openTemplate: string;
  onGoToStep: (stepId: string) => void;
}) {
  const rendered = actions
    .map((a, i) => {
      if (a.kind === 'goto-step' && a.stepId) {
        const label = stepLabels[a.stepId];
        if (!label) return null;
        const stepId = a.stepId;
        return (
          <button
            key={`s${i}`}
            type="button"
            className="rounded-full border border-[var(--border)] px-3 py-1 text-xs"
            onClick={() => onGoToStep(stepId)}
          >
            {gotoTemplate.replace('{{step}}', label)}
          </button>
        );
      }
      if (a.kind === 'open-doc' && a.slug) {
        const key = DOC_KEYS[a.slug];
        if (!key) return null;
        return (
          <a
            key={`d${i}`}
            href={routes.legal(a.slug)}
            className="rounded-full border border-[var(--border)] px-3 py-1 text-xs"
          >
            {openTemplate.replace('{{doc}}', docLabels[key])}
          </a>
        );
      }
      return null;
    })
    .filter(Boolean);

  if (!rendered.length) return null;
  return <div className="flex flex-wrap gap-2">{rendered}</div>;
}
