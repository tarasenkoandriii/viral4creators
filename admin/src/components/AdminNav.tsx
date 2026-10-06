'use client';

// Навигация админки — боковая панель на десктопе и выдвижная на телефоне
// (doc/ADMIN-NAV-AUDIT-2026-10-06.md).
//
// Раньше: строка вкладок с четырьмя выпадающими группами, из них
// «Система» — сборная на 12 ссылок; выпадающий список без ограничения
// высоты; Escape не возвращал фокус. Теперь: «Обзор» отдельно и первым,
// восемь групп по задачам оператора (каталог — `lib/nav.ts`), группы —
// раскрывающиеся разделы с обычными ссылками (disclosure, а не
// application menu: `aria-expanded` + `aria-controls`, без
// `aria-haspopup`), раскрытие запоминается.
//
// Клавиатура:
//  - Tab/Shift+Tab — обычный порядок: кнопки групп и ссылки.
//  - Enter/Space на кнопке группы — раскрыть/свернуть.
//  - Escape внутри раскрытой группы — свернуть её и вернуть фокус на её
//    кнопку; в выдвижной панели — закрыть панель и вернуть фокус на
//    кнопку «Меню».
//  - В открытой выдвижной панели Tab не уходит под затемнение.
//
// Скрыта на /login (сессии ещё нет) и пока идёт первая проверка
// /admin/auth/me.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useAdminAuth } from '../lib/admin-auth-context';
import {
  activeGroupKey,
  activeLabel,
  isNavActive,
  NAV_EXPANDED_STORAGE_KEY,
  NAV_GROUPS,
  OVERVIEW_LINK,
  parseExpanded,
} from '../lib/nav';
import UserBadge from './UserBadge';

const DRAWER_ID = 'admin-nav-drawer';

function readExpanded(): string[] | null {
  try {
    return parseExpanded(window.localStorage.getItem(NAV_EXPANDED_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeExpanded(keys: string[]): void {
  try {
    window.localStorage.setItem(NAV_EXPANDED_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Приватное окно / запрет хранилища: раскрытие просто не запомнится.
  }
}

export function AdminNav() {
  const pathname = usePathname();
  const { me, loading, logout } = useAdminAuth();
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const active = activeGroupKey(pathname);
    return new Set(active ? [active] : []);
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const restored = useRef(false);

  // Запомненное раскрытие — после монтирования (на сервере хранилища
  // нет, иначе разметка разошлась бы с гидратацией).
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const saved = readExpanded();
    if (!saved) return;
    setExpanded((cur) => new Set([...saved, ...cur]));
  }, []);

  // Переход: раскрыть группу текущей страницы и закрыть выдвижную
  // панель (иначе она осталась бы поверх нового экрана).
  useEffect(() => {
    const active = activeGroupKey(pathname);
    if (active) {
      setExpanded((cur) => (cur.has(active) ? cur : new Set([...cur, active])));
    }
    setDrawerOpen(false);
  }, [pathname]);

  const toggleGroup = useCallback((key: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeExpanded([...next]);
      return next;
    });
  }, []);

  const closeDrawer = useCallback((returnFocus: boolean) => {
    setDrawerOpen(false);
    if (returnFocus) {
      // После перерисовки: кнопка «Меню» видна, панель скрыта.
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
    }
  }, []);

  // Открытая панель: фокус внутрь, Escape закрывает, прокрутка
  // страницы под затемнением заблокирована.
  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    const first = drawer?.querySelector<HTMLElement>('a, button');
    first?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDrawer(true);
        return;
      }
      if (e.key !== 'Tab' || !drawer) return;
      const focusables = Array.from(
        drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [drawerOpen, closeDrawer]);

  if (pathname === '/login' || loading || !me) return null;

  const onGroupKeyDown = (key: string) => (e: ReactKeyboardEvent<HTMLElement>) => {
    // В выдвижной панели Escape закрывает саму панель (обработчик выше).
    if (e.key !== 'Escape' || drawerOpen || !expanded.has(key)) return;
    e.preventDefault();
    e.stopPropagation();
    toggleGroup(key);
    document.getElementById(`admin-nav-btn-${key}`)?.focus();
  };

  const current = activeLabel(pathname);

  return (
    <>
      {/* Мобильная шапка: «Меню» + где я. На десктопе скрыта CSS. */}
      <div className="admin-topbar">
        <button
          type="button"
          ref={menuButtonRef}
          className="admin-topbar-menu"
          aria-expanded={drawerOpen}
          aria-controls={DRAWER_ID}
          onClick={() => setDrawerOpen((v) => !v)}
        >
          <span aria-hidden="true">☰</span> Меню
        </button>
        <span className="admin-topbar-title">{current ?? 'Админка'}</span>
      </div>

      {drawerOpen && (
        <div className="admin-nav-backdrop" aria-hidden="true" onClick={() => closeDrawer(true)} />
      )}

      <nav
        id={DRAWER_ID}
        ref={drawerRef}
        className={drawerOpen ? 'admin-sidebar admin-sidebar-open' : 'admin-sidebar'}
        aria-label="Разделы админки"
      >
        <div className="admin-sidebar-head">
          <span className="admin-sidebar-brand">viral4creators</span>
          <span className="muted">админка</span>
          {drawerOpen && (
            <button
              type="button"
              className="admin-sidebar-close"
              aria-label="Закрыть меню"
              onClick={() => closeDrawer(true)}
            >
              ✕
            </button>
          )}
        </div>

        <div className="admin-sidebar-scroll">
          <Link
            href={OVERVIEW_LINK.href}
            className="admin-nav-link admin-nav-overview"
            aria-current={isNavActive(pathname, OVERVIEW_LINK.href) ? 'page' : undefined}
          >
            {OVERVIEW_LINK.label}
          </Link>

          <ul className="admin-nav-groups">
            {NAV_GROUPS.map((group) => {
              const open = expanded.has(group.key);
              const hasActive = group.links.some((l) => isNavActive(pathname, l.href));
              const listId = `admin-nav-group-${group.key}`;
              return (
                <li key={group.key} className="admin-nav-group" onKeyDown={onGroupKeyDown(group.key)}>
                  <button
                    type="button"
                    id={`admin-nav-btn-${group.key}`}
                    className={hasActive ? 'admin-nav-group-btn admin-nav-group-btn-active' : 'admin-nav-group-btn'}
                    aria-expanded={open}
                    aria-controls={listId}
                    onClick={() => toggleGroup(group.key)}
                  >
                    <span>{group.label}</span>
                    <span className="admin-nav-chevron" aria-hidden="true">
                      {open ? '▾' : '▸'}
                    </span>
                  </button>
                  <ul id={listId} className="admin-nav-links" hidden={!open}>
                    {group.links.map((link) => (
                      <li key={link.href}>
                        <Link
                          href={link.href}
                          className="admin-nav-link"
                          aria-current={isNavActive(pathname, link.href) ? 'page' : undefined}
                        >
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="admin-sidebar-me">
          <span className="muted">
            <UserBadge userId={me.userId} copy={false} />
          </span>
          <button type="button" onClick={() => void logout()}>
            Выйти
          </button>
        </div>
      </nav>
    </>
  );
}
