import Link from 'next/link';

/**
 * Своя 404 (этап 50, В-5.16): дефолт Next.js — англоязычный белый экран
 * без единой ссылки, в русском интерфейсе с тёмной темой по умолчанию.
 * Его видит человек по устаревшей ссылке — и выхода у него нет.
 */
export default function NotFound() {
  return (
    <main className="admin-main">
      <h1>Страницы нет</h1>
      <p className="muted">
        Такого раздела в админке нет или ссылка устарела.
      </p>
      <p>
        <Link href="/sessions">К сессиям</Link>
      </p>
    </main>
  );
}
