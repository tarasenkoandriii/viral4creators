'use client';

import { useId, useState } from 'react';

export interface FaqEntry {
  q: string;
  a: string;
  /** Уже решено сервером: показывать ли метку «скоро» (реестр утверждений). */
  soon: boolean;
  claim: string;
}

/**
 * FAQ на `button[aria-expanded]` (ТЗ §3.12, §12 — как `landing/src/components/Faq.tsx`).
 *
 * Отличие от образца: ответы ВСЕГДА есть в серверном HTML (скрыты
 * атрибутом `hidden`, а не отсутствуют) — поисковик и наш будущий виджет
 * (§3.12: «FAQ — тоже знания виджета») видят все ответы. Начальное
 * состояние одинаково на сервере и клиенте (открыт первый вопрос) —
 * никакого «схлопывания» после гидратации, то есть и сдвига вёрстки (CLS).
 *
 * Тексты и решение «скоро/нет» приходят пропсами: словарь и реестр в
 * клиентский бандл не попадают.
 */
export function Faq({ items, soonLabel, soonTitle }: { items: readonly FaqEntry[]; soonLabel: string; soonTitle: string }) {
  const baseId = useId();
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="faq-list">
      {items.map((item, index) => {
        const isOpen = open === index;
        const answerId = `${baseId}-a${index}`;
        return (
          <div
            className={`faq-item claim ${item.soon ? 'claim-soon' : 'claim-live'}`}
            key={item.q}
            data-claim={item.claim}
            data-claim-status={item.soon ? 'soon' : 'live'}
          >
            <h3 className="faq-q">
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={answerId}
                onClick={() => setOpen(open === index ? null : index)}
              >
                <span>
                  {item.q}{' '}
                  {item.soon && (
                    <span className="badge-soon" title={soonTitle}>
                      {soonLabel}
                    </span>
                  )}
                </span>
                <span className="faq-icon" aria-hidden="true">
                  {isOpen ? '−' : '+'}
                </span>
              </button>
            </h3>
            <div id={answerId} className="faq-a" hidden={!isOpen}>
              <p>{item.a}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
