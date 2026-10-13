import type { FaqItem } from '@/lib/api-types';

/** FAQ посадочной: активные факты `faq` из site-config (≤ 5), `<details>` без JS. */
export default function Faq({ items }: { items: FaqItem[] }) {
  return (
    <div className="faq">
      {items.map((it, i) => (
        <details key={i}>
          <summary>{it.question}</summary>
          <p>{it.answer}</p>
        </details>
      ))}
    </div>
  );
}
