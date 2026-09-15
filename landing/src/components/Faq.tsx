'use client';

import { useState } from 'react';
import { useDictionary } from '../lib/dictionary-context';

export function Faq() {
  const { dict } = useDictionary();
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div className="faq-list">
      {dict.faq.items.map((item, index) => {
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
            data-faq-index={index}
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
