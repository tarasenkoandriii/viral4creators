import type { AltContact as Alt } from '@/lib/api-types';

/**
 * Альтернативный контакт (утверждённый параметр `alt_contact`): виден
 * всегда — на странице формы, в подвале, в ошибках формы и в `<noscript>`.
 * Если конфигурация ещё пуста — утверждённый владельцем контакт платформы.
 */
export default function AltContact({ value, label, missing }: { value: Alt | null; label: string; missing: string }) {
  const contact = value ?? { label: '@ConscienceUkraine', href: 'https://t.me/ConscienceUkraine' };
  return (
    <p className="alt-contact" data-testid="alt-contact">
      <span>{label}: </span>
      {contact ? (
        contact.href ? (
          <a href={contact.href}>{contact.label}</a>
        ) : (
          <span>{contact.label}</span>
        )
      ) : (
        <span>{missing}</span>
      )}
    </p>
  );
}
