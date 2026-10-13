import type { AltContact as Alt } from '@/lib/api-types';

/**
 * Альтернативный контакт (утверждённый параметр `alt_contact`): виден
 * всегда — на странице формы, в подвале, в ошибках формы и в `<noscript>`.
 * Не утверждён — честная строка, а не выдуманный адрес.
 */
export default function AltContact({ value, label, missing }: { value: Alt | null; label: string; missing: string }) {
  return (
    <p className="alt-contact" data-testid="alt-contact">
      <span>{label}: </span>
      {value ? (
        value.href ? (
          <a href={value.href}>{value.label}</a>
        ) : (
          <span>{value.label}</span>
        )
      ) : (
        <span>{missing}</span>
      )}
    </p>
  );
}
