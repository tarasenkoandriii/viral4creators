import { Fragment } from 'react';
import type { Dictionary } from '../lib/get-dictionary';
import { IllustrationIcon } from './IllustrationIcon';

/**
 * Блок-схема пайплайна + карточки шагов — этап 79
 * (doc/LANDING-HOW-IT-WORKS-VISUAL-SPEC.md). Один компонент для ДВУХ
 * мест (§3.0 ТЗ): короткий тизер в секции `#how` на главной
 * (`variant="teaser"`) и полная версия на выделенной странице
 * `/[locale]/how-it-works` (`variant="full"`) — разница только в
 * пропе `variant` (короткий `highlight` vs полный `details[]`) и в
 * базовом URL для ссылок блок-схемы (`hrefBase`, §3.1). Серверный
 * компонент — никакого `'use client'`, вся интерактивность (переход к
 * карточке, раскрытие списка шага 9) — якорные ссылки и нативный
 * `<details>`, без React-состояния (§3.2, §7 ТЗ).
 */

type StepsDict = Dictionary['steps'];
type StepItem = StepsDict['items'][number];
// JSON-модули типизируют строковые значения как `string`, не как
// литералы ('standard'|'premium'|'login') — `badge` в словаре и ключи
// `steps.badges` оба остаются `string`, индексация ниже безопасна и без
// сужения типа.
type BadgeMap = Record<string, string>;

interface HowItWorksProps {
  steps: StepsDict;
  variant: 'teaser' | 'full';
  /** '' на выделенной странице (клик прокручивает на той же странице);
   * `/${locale}/how-it-works` на главной (клик уводит на полную
   * страницу сразу к нужному шагу, §3.1 ТЗ). */
  hrefBase: string;
}

// Словарные JSON-файлы неоднородны по набору необязательных полей между
// пунктами `items[]` (не у каждого шага есть `badge`/`highlight`) — тип
// массива, который выводит TS из литерала, поэтому объединение разных
// форм объекта, а не единая форма с необязательными полями. Прямое
// обращение `step.badge` не типизируется для тех пунктов, где ключа нет
// вовсе — тот же приём defensive-доступа, что уже применяет
// `page.tsx` для `plans.items[].highlight` (`'highlight' in plan`).
function getBadge(step: StepItem): string | undefined {
  return 'badge' in step ? step.badge : undefined;
}

function getHighlight(step: StepItem): string | undefined {
  return 'highlight' in step ? step.highlight : undefined;
}

// Фаза 2 ТЗ (doc/LANDING-ILLUSTRATIONS-BRIEF.md §3) — line-art SVG вместо
// глифа-заглушки; файлы `landing/public/illustrations/how-step-N.svg`.
function StepIcon({ n, size }: { n: number; size: number }) {
  return <IllustrationIcon name={`how-step-${n}`} size={size} />;
}

export function HowItWorks({ steps, variant, hrefBase }: HowItWorksProps) {
  return (
    <>
      <nav className="how-diagram" aria-label={steps.title}>
        {steps.items.map((step, index) => {
          const n = index + 1;
          const badge = getBadge(step);
          return (
            <Fragment key={step.title}>
              {index > 0 && (
                <span className="how-diagram-arrow" aria-hidden="true">
                  →
                </span>
              )}
              <a href={`${hrefBase}#step-${n}`} className="how-diagram-box">
                <span className="feature-icon" aria-hidden="true">
                  <StepIcon n={n} size={20} />
                </span>
                {/* §3.1 ТЗ: короткая подпись (2-4 слова), НЕ полный
                    заголовок шага — иначе самый длинный заголовок (шаг 7)
                    визуально раздувает один блок сильнее остальных
                    восьми, ломая «карту одним взглядом». */}
                <span className="how-diagram-label">{step.shortLabel}</span>
                {/* §3.1 ТЗ: «+ бейдж плана, если шаг что-то ограничивает» —
                    диаграмма раньше показывала только иконку и подпись. */}
                {badge && (
                  <span className="badge badge-plan how-diagram-badge">
                    {(steps.badges as BadgeMap)[badge]}
                  </span>
                )}
              </a>
            </Fragment>
          );
        })}
      </nav>

      <ol className="steps-grid">
        {steps.items.map((step, index) => {
          const n = index + 1;
          const badge = getBadge(step);
          const highlight = getHighlight(step);
          const hasDetails = step.details.length > 0;

          return (
            <li id={`step-${n}`} className="step-card" key={step.title}>
              <div className="step-card-head">
                <span className="step-number">{n}</span>
                <span className="feature-icon" aria-hidden="true">
                  <StepIcon n={n} size={16} />
                </span>
                <strong>{step.title}</strong>
                {badge && (
                  <span className="badge badge-plan">{(steps.badges as BadgeMap)[badge]}</span>
                )}
              </div>
              <p>{step.text}</p>

              {variant === 'full' && hasDetails && (
                // Шаг 10 (этап 92, был шаг 9 до появления отдельного шага
                // про «Постпродакшн») — единственный со сворачиваемым
                // списком (§3.3 ТЗ, пять опциональных пунктов результата
                // не помещаются без сворачивания); остальные девять
                // показывают список сразу, 2-4 пункта не загромождают
                // карточку.
                n === 10 ? (
                  <details>
                    <summary>{steps.detailsToggle}</summary>
                    <ul className="step-details">
                      {step.details.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  <ul className="step-details">
                    {step.details.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )
              )}

              {variant === 'teaser' && highlight && <p className="step-highlight">{highlight}</p>}

              {/* Точка входа в ИИ-консультанта с контекстом конкретного
                  шага (§6.2 ТЗ AI-консультанта) — сама кнопка не требует
                  JS для рендера (SSR), но без JS ничего не произойдёт по
                  клику: AssistantWidget слушает эти data-атрибуты через
                  делегирование на document (виджет и так весь клиентский,
                  деградация «нет JS → нет консультанта» уже верна для
                  всей фичи, не только для этой кнопки). */}
              <button
                type="button"
                className="step-ask-btn"
                data-assistant-ask-step={n}
                data-assistant-step-title={step.title}
              >
                {steps.askAbout}
              </button>
            </li>
          );
        })}
      </ol>

      {variant === 'teaser' && (
        <a className="cta cta-ghost cta-small" href={hrefBase}>
          {steps.moreLink}
        </a>
      )}
    </>
  );
}
