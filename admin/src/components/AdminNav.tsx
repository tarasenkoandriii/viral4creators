'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAdminAuth } from '../lib/admin-auth-context';

type NavEntry =
  | { kind: 'link'; href: string; label: string }
  | { kind: 'group'; label: string; links: Array<[string, string]> };

// Раньше здесь был плоский список из шестнадцати ссылок — на обычной
// ширине окна он переносился на две строки (см. историю этого файла).
// Сгруппировано по смыслу в пять пунктов верхнего уровня: «Сессии» —
// самый частый экран оператора, оставлен отдельной ссылкой без
// вложенности; остальное — в четыре выпадающих группы. Порядок ссылок
// внутри каждой группы — тот же, что был в исходном плоском списке.
const NAV: NavEntry[] = [
  { kind: 'link', href: '/sessions', label: 'Сессии' },
  {
    kind: 'group',
    label: 'Контент',
    links: [
      ['/publications', 'Модерация'],
      ['/shared-videos', 'Публичные страницы'],
      ['/creator-profiles', 'Маркетплейс: исполнители'],
      ['/portfolio-items', 'Маркетплейс: модерация портфолио'],
      ['/auctions', 'Маркетплейс: модерация аукциона'],
      ['/library', 'Библиотека'],
      ['/blog', 'Блог'],
    ],
  },
  {
    kind: 'group',
    label: 'Коммерция',
    links: [
      ['/users', 'Пользователи'],
      ['/payments', 'Оплата'],
      ['/marketing', 'Рассылка'],
      ['/costs', 'Расходы'],
      ['/balances', 'Балансы'],
    ],
  },
  {
    kind: 'group',
    label: 'Генерация',
    links: [
      ['/catalog-batches', 'Пакетная генерация'],
      ['/ab-tests', 'A/B-варианты'],
      ['/feed-imports', 'Импорт фида'],
      ['/actors', 'AI-аватар (пилот)'],
      ['/virtual-studio', 'Виртуальная студия'],
    ],
  },
  {
    kind: 'group',
    label: 'Система',
    links: [
      ['/cron', 'Кроны'],
      ['/telemetry', 'Телеметрия'],
      ['/funnel', 'Воронка'],
      ['/referrals', 'Приглашения'],
      ['/assistant', 'ИИ-консультант'],
      ['/wizard-guide', 'Советник в мастере'],
      ['/tutorial-scenarios', 'Сценарии обучалки'],
      ['/site-tutorial-drafts', 'Обучалки по сайтам'],
      ['/settings', 'Настройки'],
    ],
  },
];

/** Скрыт на /login (там ещё нет сессии, показывать нечего) и пока
 * идёт первая проверка /admin/auth/me. */
export function AdminNav() {
  const pathname = usePathname();
  const { me, loading, logout } = useAdminAuth();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

  // Переход на другую страницу (в том числе внутри открытой группы)
  // должен закрывать выпадающий список — иначе он остаётся висеть
  // поверх уже другого экрана.
  useEffect(() => {
    setOpenGroup(null);
  }, [pathname]);

  // Клик мимо меню и Escape закрывают открытую группу — то же
  // поведение, что ожидается от любого выпадающего меню в браузере.
  useEffect(() => {
    if (!openGroup) return;
    function onDocClick(e: MouseEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setOpenGroup(null);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpenGroup(null);
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openGroup]);

  if (pathname === '/login' || loading || !me) return null;

  return (
    // Раскладка (перенос, отступы) — в globals.css (`.admin-nav`), тем
    // же способом, что и раньше: инлайновый стиль не слышит медиазапрос.
    <nav className="admin-nav" aria-label="Разделы админки" ref={navRef}>
      {NAV.map((entry) =>
        entry.kind === 'link' ? (
          <Link
            key={entry.href}
            href={entry.href}
            // Этап 50 (В-5.18): текущая вкладка помечена и для глаз (CSS), и
            // для скринридера.
            aria-current={pathname.startsWith(entry.href) ? 'page' : undefined}
          >
            {entry.label}
          </Link>
        ) : (
          <div className="admin-nav-group" key={entry.label}>
            <button
              type="button"
              className={
                entry.links.some(([href]) => pathname.startsWith(href))
                  ? 'admin-nav-group-btn admin-nav-group-btn-active'
                  : 'admin-nav-group-btn'
              }
              aria-haspopup="true"
              aria-expanded={openGroup === entry.label}
              onClick={() => setOpenGroup((cur) => (cur === entry.label ? null : entry.label))}
            >
              {entry.label} <span aria-hidden="true">{openGroup === entry.label ? '▴' : '▾'}</span>
            </button>
            {openGroup === entry.label && (
              <ul className="admin-nav-dropdown">
                {entry.links.map(([href, label]) => (
                  <li key={href}>
                    <Link href={href} aria-current={pathname.startsWith(href) ? 'page' : undefined}>
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ),
      )}
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
