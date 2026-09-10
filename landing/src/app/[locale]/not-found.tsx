'use client';

import Link from 'next/link';
import { useDictionary } from '../../lib/dictionary-context';

/**
 * 404 внутри локали (этап 55) — тот же экран, что и корневой
 * app/not-found.tsx (этап 50, В-5.16), но текст читается из словаря
 * текущего языка, а не только по-русски. Корневой not-found.tsx
 * остаётся как последний резерв — для путей вне [locale] (например,
 * опечатка внутри /legal/*).
 */
export default function LocaleNotFound() {
  const { dict, locale } = useDictionary();
  return (
    <main className="wrap" style={{ padding: '96px 0', textAlign: 'center' }}>
      <h1>{dict.notFound.title}</h1>
      <p style={{ color: 'var(--muted)' }}>{dict.notFound.text}</p>
      <p>
        <Link className="cta" href={`/${locale}`}>
          {dict.notFound.backHome}
        </Link>
      </p>
    </main>
  );
}
