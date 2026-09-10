'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAdminAuth } from '../lib/admin-auth-context';

const LINKS: Array<[string, string]> = [
  ['/sessions', 'Сессии'],
  ['/publications', 'Модерация'],
  ['/shared-videos', 'Публичные страницы'],
  ['/library', 'Библиотека'],
  ['/blog', 'Блог'],
  ['/users', 'Пользователи'],
  ['/payments', 'Оплата'],
  ['/marketing', 'Рассылка'],
  ['/catalog-batches', 'Пакетная генерация'],
  ['/ab-tests', 'A/B-варианты'],
  ['/feed-imports', 'Импорт фида'],
  ['/cron', 'Кроны'],
  ['/actors', 'AI-аватар (пилот)'],
  ['/costs', 'Расходы'],
  ['/telemetry', 'Телеметрия'],
  ['/settings', 'Настройки'],
];

/** Скрыт на /login (там ещё нет сессии, показывать нечего) и пока
 * идёт первая проверка /admin/auth/me. */
export function AdminNav() {
  const pathname = usePathname();
  const { me, loading, logout } = useAdminAuth();

  if (pathname === '/login' || loading || !me) return null;

  return (
    // Раскладка уехала в globals.css (`.admin-nav`): в одну нерушимую
    // flex-строку семь ссылок с id и «Выйти» требовали 797px и тянули за
    // собой ВЕСЬ документ на любой странице админки. В CSS она умеет
    // переноситься и слушать медиазапрос, инлайновый стиль — нет.
    <nav className="admin-nav" aria-label="Разделы админки">
      {LINKS.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          // Этап 50 (В-5.18): текущая вкладка помечена и для глаз (CSS), и
          // для скринридера.
          aria-current={pathname.startsWith(href) ? 'page' : undefined}
        >
          {label}
        </Link>
      ))}
      {/* Кто вошёл и «Выйти» — одна группа: при переносе они должны
          уехать на новую строку вместе и остаться у правого края, иначе
          кнопка отрывается от имени и висит слева сама по себе. */}
      <div className="admin-nav-me">
        <span className="muted">{me.userId}</span>
        <button type="button" onClick={() => void logout()}>
          Выйти
        </button>
      </div>
    </nav>
  );
}
