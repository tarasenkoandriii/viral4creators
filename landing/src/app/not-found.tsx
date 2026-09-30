import Link from 'next/link';
import { HtmlDocument } from '../components/HtmlDocument';

/**
 * Своя 404 (этап 50, В-5.16): дефолт Next.js — англоязычный белый экран
 * без единой ссылки на тёмном сайте. Его видит человек по устаревшей
 * ссылке вроде `/legal/privacy`.
 *
 * Сам рисует `<html>`: корневой layout только пропускает детей, а эта
 * страница рендерится прямо под ним — в том числе когда
 * `app/[locale]/layout.tsx` отвечает `notFound()` на чужой сегмент. Язык —
 * `ru`, как у всего вне `[locale]`; 404 внутри локали — свой,
 * `app/[locale]/not-found.tsx`.
 */
export default function NotFound() {
  return (
    <HtmlDocument locale="ru">
      <main className="wrap" style={{ padding: '96px 0', textAlign: 'center' }}>
        <h1>Такой страницы нет</h1>
        <p style={{ color: 'var(--muted)' }}>
          Ссылка устарела или в ней опечатка.
        </p>
        <p>
          <Link className="cta" href="/">
            На главную
          </Link>
        </p>
      </main>
    </HtmlDocument>
  );
}
