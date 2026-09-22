'use client';

import { useState } from 'react';
import { useDictionary } from '../lib/dictionary-context';

interface FaqItem {
  question: string;
  answer: string;
}

/**
 * Этап 3 поздравлений (находка 1.3 аудита). ТЗ лендинга (раздел 4 п.7)
 * планировало переиспользовать этот компонент со своим набором
 * вопросов — а он своего набора не принимал вовсе, только читал
 * `dict.faq` из контекста локали.
 *
 * `items` добавлен, но с оговоркой, которой в ТЗ не было. Атрибут
 * `data-faq-index` ниже — это адрес, по которому ИИ-консультант
 * прокручивает страницу, получив от бэкенда `action {kind:'faq',
 * faqIndex}`; индексы там считаются по ГЛАВНОМУ словарю. Второй FAQ с
 * теми же атрибутами дал бы консультанту два разных ответа под одним
 * номером. Поэтому атрибут выводится только у набора по умолчанию: для
 * чужого набора адресации просто нет, и перепутать нечего.
 */
export function Faq({ items }: { items?: readonly FaqItem[] } = {}) {
  const { dict } = useDictionary();
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const list: readonly FaqItem[] = items ?? dict.faq.items;
  const addressable = items === undefined;

  return (
    <div className="faq-list">
      {list.map((item, index) => {
        const isOpen = openIndex === index;
        return (
          <div
            className={`faq-item ${isOpen ? 'faq-item-open' : ''}`}
            key={item.question}
            // Найдено доп. аудитом: ИИ-консультант умеет прислать action
            // {kind:'faq', faqIndex} (backend/assistant/actions.ts
            // валидирует диапазон), но раньше это поле нигде на фронтенде
            // не читалось — клик по подсказке всегда просто прыгал к
            // началу секции FAQ целиком, что бы ни ответил ассистент.
            // `data-faq-index` — тот же приём, что уже есть у
            // `data-plan-id` для action 'plan' (см. AssistantWidget.tsx).
            data-faq-index={addressable ? index : undefined}
          >
            <button
              type="button"
              className="faq-question"
              aria-expanded={isOpen}
              onClick={() => setOpenIndex(isOpen ? null : index)}
            >
              <span>{item.question}</span>
              <span className="faq-icon" aria-hidden="true">
                {isOpen ? '−' : '+'}
              </span>
            </button>
            {isOpen && <p className="faq-answer">{item.answer}</p>}
          </div>
        );
      })}
    </div>
  );
}
