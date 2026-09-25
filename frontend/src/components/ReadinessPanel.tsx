/**
 * «До готового ролика» — «Тонкая красная линия», этап 4
 * (docs-tz/TZ-Tonkaya-Krasnaya-Liniya.md §7.4).
 *
 * Три решения, каждое против правдоподобного, но неверного варианта:
 *
 * 1. **Выполненные пункты не исчезают, а сереют.** Исчезающий список не
 *    даёт увидеть, что путь конечен: человек видит «осталось два» и не
 *    знает, два из трёх это или два из десяти.
 * 2. **Необязательное — отдельной группой.** Смешать его с
 *    обязательным значит получить «осталось 7 пунктов» там, где до
 *    кнопки один шаг.
 * 3. **Пункт кликается и ведёт на свой шаг.** Без этого «не хватает
 *    заголовка» — сообщение, а не путь; ровно та беспомощность, ради
 *    устранения которой заводится вся линия.
 *
 * Счётчика здесь может не быть вовсе: у обучалки число раундов заранее
 * неизвестно, и «осталось N» было бы выдумкой (§7.3). Поэтому компонент
 * показывает СОСТОЯНИЕ — «готово» или «осталось столько-то пунктов», —
 * а не прогресс-бар.
 */

import { useState } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import type { Readiness } from '../types';
import { useI18n } from '../lib/i18n-context';
import { pluralForm } from '../features/projects/format';

export function ReadinessPanel({
  readiness,
  onGoToStep,
  canGoToStep,
  itemLabels,
}: {
  readiness: Readiness;
  /** Не задан — пункты не кликаются (шага, куда вести, нет). */
  onGoToStep?: (stepId: string) => void;
  /**
   * Открыт ли шаг ПРЯМО СЕЙЧАС. Не задан — считаем, что открыт любой.
   *
   * Готовность перечисляет всё, чего не хватает, включая то, что
   * заполняется на шаге, куда с текущего места ещё нельзя: у обучалки
   * название просят на просмотре, а просмотр недостижим, пока не
   * записан ни один кадр. Строка без этой проверки оставалась
   * кликабельной и молча ничего не делала.
   */
  canGoToStep?: (stepId: string) => boolean;
  /**
   * Подписи отдельных пунктов вместо словарных.
   *
   * Один и тот же пункт готовности бывает закрыт РАЗНОЙ работой:
   * «откуда берётся сцена» закрывает либо разбор референса, либо
   * выбранный приём (этап 149). Общая подпись про разбор с галочкой
   * рапортовала бы о работе, которой не было.
   */
  itemLabels?: Record<string, string>;
}) {
  const { dict, locale } = useI18n();
  const t = dict.wizardReadiness;
  const [open, setOpen] = useState(false);

  if (readiness.items.length === 0) return null;

  const required = readiness.items.filter((i) => i.required);
  const optional = readiness.items.filter((i) => !i.required);
  const label = readiness.canGenerate
    ? t.ready
    : `${t.title}: ${pluralForm(readiness.missingRequired, locale, t.count)}`;

  const row = (item: Readiness['items'][number]) => {
    const name =
      itemLabels?.[item.key] ??
      t.items[item.key as keyof typeof t.items] ??
      item.key;
    const clickable =
      !item.done && !!onGoToStep && (canGoToStep?.(item.stepId) ?? true);
    return (
      <li key={item.key} className="flex items-start gap-2 text-sm">
        <span
          className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full ${
            item.done
              ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
              : 'border border-[var(--border)]'
          }`}
        >
          {item.done && <Check size={10} />}
        </span>
        {clickable ? (
          <button
            type="button"
            className="text-left underline decoration-dotted underline-offset-2"
            onClick={() => onGoToStep(item.stepId)}
          >
            {name}
          </button>
        ) : (
          <span className={item.done ? 'text-[var(--muted)]' : ''}>{name}</span>
        )}
      </li>
    );
  };

  return (
    <div className="mb-3 rounded-lg border border-[var(--border)] p-3">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-sm font-medium"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{label}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <ul className="space-y-1.5">{required.map(row)}</ul>
          {optional.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs text-[var(--muted)]">
                {t.optionalGroup}
              </p>
              <ul className="space-y-1.5">{optional.map(row)}</ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
