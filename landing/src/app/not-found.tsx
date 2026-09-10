import Link from 'next/link';

/**
 * Своя 404 (этап 50, В-5.16): дефолт Next.js — англоязычный белый экран
 * без единой ссылки на тёмном сайте. Его видит человек по устаревшей
 * ссылке вроде `/legal/privacy`.
 */
export default function NotFound() {
  return (
    <main className="wrap" style={{ padding: '96px 0', textAlign: 'center' }}>
      <h1>Такой страницы нет</h1>
      <p style={{ color: 'var(--muted)' }}>Ссылка устарела или в ней опечатка.</p>
      <p>
        <Link className="cta" href="/">
          На главную
        </Link>
      </p>
    </main>
  );
}
