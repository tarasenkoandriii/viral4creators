/**
 * Иллюстрация первого экрана Story‑Tales (ТЗ §6.2, §8; ST-LPL-02).
 *
 * Собственный простой рисунок, а не съёмка и не кадр из роликов:
 * одобренных материалов пока нет (Р-STL-9). Что в нём намеренно:
 *
 *  - взрослый рассказчик — ОТДЕЛЬНАЯ карточка рядом со сказочной сценой,
 *    связь — пунктир между ними; без рамки звонка, кнопок, камеры и
 *    прочего, что читалось бы как видеозвонок;
 *  - у фигуры нет лица: это знак «человек», а не портрет — рисунок не
 *    должен выглядеть записью конкретного родителя пользователя;
 *  - НЕТ кнопки воспроизведения: ролика нет, и треугольник «Play» поверх
 *    картинки был бы обманом (§5.1);
 *  - подпись «Иллюстрация формата» — видимым текстом `<figcaption>` на
 *    каждом языке, а не только в `alt`.
 *
 * Цвета — классы `.st-svg-*` с токенами `stories.css`, поэтому рисунок
 * сам переключается в ночную тему. Пропорции зарезервированы `viewBox` и
 * `aspect-ratio`: сдвига раскладки нет.
 */
export function HeroIllustration({
  alt,
  caption,
  narratorLabel,
  taleLabel,
}: {
  alt: string;
  caption: string;
  narratorLabel: string;
  taleLabel: string;
}) {
  return (
    <figure className="st-figure" data-illustration="format">
      <div className="st-illustration" role="img" aria-label={alt}>
        <div className="st-ill-card st-ill-narrator">
          <svg viewBox="0 0 160 200" aria-hidden="true" focusable="false">
            <rect className="st-svg-paper" x="0" y="0" width="160" height="200" />
            {/* Звуковые дуги — «говорит», без микрофона и экрана. */}
            <path className="st-svg-wave" d="M120 62 q10 12 0 24" />
            <path className="st-svg-wave" d="M130 54 q18 20 0 40" />
            {/* Голова без черт лица и плечи. */}
            <circle className="st-svg-figure" cx="78" cy="78" r="28" />
            <path className="st-svg-cloth" d="M24 200 C24 146 50 120 78 120 C106 120 132 146 132 200 Z" />
            {/* Раскрытая книга в руках. */}
            <path className="st-svg-paper" d="M50 162 L78 170 L106 162 L106 186 L78 194 L50 186 Z" />
            <path className="st-svg-link" d="M78 170 L78 194" />
          </svg>
          <span className="st-ill-label" aria-hidden="true">
            {narratorLabel}
          </span>
        </div>
        <svg className="st-ill-link" viewBox="0 0 28 12" aria-hidden="true" focusable="false">
          <path className="st-svg-link" d="M2 6 L26 6" />
        </svg>
        <div className="st-ill-card st-ill-tale">
          <svg viewBox="0 0 280 200" aria-hidden="true" focusable="false">
            <rect className="st-svg-sky" x="0" y="0" width="280" height="200" />
            <circle className="st-svg-moon" cx="226" cy="44" r="20" />
            <circle className="st-svg-sky" cx="236" cy="38" r="17" />
            <circle className="st-svg-moon" cx="40" cy="30" r="2.5" />
            <circle className="st-svg-moon" cx="90" cy="52" r="2" />
            <circle className="st-svg-moon" cx="150" cy="24" r="2.5" />
            <circle className="st-svg-moon" cx="190" cy="74" r="2" />
            <path className="st-svg-hill-far" d="M0 140 C60 104 120 118 170 130 C210 140 250 120 280 112 L280 200 L0 200 Z" />
            <path className="st-svg-hill" d="M0 168 C70 138 150 150 280 160 L280 200 L0 200 Z" />
            {/* Домик с тёплым окном. */}
            <rect className="st-svg-house" x="118" y="118" width="48" height="40" />
            <path className="st-svg-roof" d="M110 120 L142 92 L174 120 Z" />
            <rect className="st-svg-window" x="134" y="128" width="16" height="14" rx="2" />
            {/* Деревья. */}
            <path className="st-svg-tree" d="M58 150 L74 104 L90 150 Z" />
            <rect className="st-svg-roof" x="71" y="150" width="6" height="12" />
            <path className="st-svg-tree" d="M206 152 L220 116 L234 152 Z" />
            <rect className="st-svg-roof" x="217" y="152" width="6" height="10" />
          </svg>
          <span className="st-ill-label" aria-hidden="true">
            {taleLabel}
          </span>
        </div>
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
