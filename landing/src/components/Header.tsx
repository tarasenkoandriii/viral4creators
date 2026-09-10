'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { TMA_URL } from '../lib/content';
import { useDictionary } from '../lib/dictionary-context';
import { LocaleSwitcher } from './LocaleSwitcher';

/**
 * Шапка с мобильным меню.
 *
 * Этап 50 (В-5.15): открытое меню — оверлей поверх содержимого, и раньше
 * оно вело себя как обычный блок: `Escape` не закрывал, клик по странице
 * не закрывал, а `Tab` уводил фокус под оверлей — в ссылки FAQ, которых в
 * этот момент не видно. Теперь меню закрывается по `Escape` и по клику
 * вне, при открытии фокус уходит на первую ссылку, а `Tab` ходит по кругу
 * внутри, пока меню открыто.
 *
 * Этап 55: подписи и ссылки читаются из словаря текущей локали, ссылки на
 * якоря (#how, #features…) от языка не зависят — сами секции остаются на
 * одной странице /[locale], меняется только их подпись в меню.
 */
export function Header() {
  const { dict, locale } = useDictionary();
  const [menuOpen, setMenuOpen] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const nav = navRef.current;
    const focusable = () =>
      Array.from(
        nav?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select') ?? []
      );
    focusable()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        toggleRef.current?.focus();
        return;
      }
      if (e.key !== 'Tab') return;
      // Фокус не покидает меню: с последнего элемента — на кнопку-бургер,
      // с бургера — на первый пункт, и обратно с Shift.
      const items = [...focusable(), toggleRef.current].filter(
        (el): el is HTMLElement => !!el
      );
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      const last = items.length - 1;
      if (!e.shiftKey && (index === last || index === -1)) {
        e.preventDefault();
        items[0].focus();
      } else if (e.shiftKey && (index === 0 || index === -1)) {
        e.preventDefault();
        items[last].focus();
      }
    };
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (nav?.contains(target) || toggleRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
    };
  }, [menuOpen]);

  return (
    <header className="site-header">
      <div className="wrap site-header-inner">
        <a href="#top" className="brand" onClick={() => setMenuOpen(false)}>
          viral4creators
        </a>

        <nav
          id="site-nav"
          ref={navRef}
          className={`site-nav ${menuOpen ? 'site-nav-open' : ''}`}
          aria-label={dict.header.navAriaLabel}
        >
          {dict.header.nav.map((link) => (
            <a key={link.href} href={link.href} onClick={() => setMenuOpen(false)}>
              {link.label}
            </a>
          ))}
          {/* Этап 58: единственная ссылка в шапке на отдельную страницу, а
              не на якорь этой же страницы — ведёт сразу под текущей
              локалью, без лишнего редиректа через middleware. */}
          <Link href={`/${locale}/blog`} onClick={() => setMenuOpen(false)}>
            {dict.header.blogLabel}
          </Link>
          <LocaleSwitcher />
          <a className="cta cta-small" href={TMA_URL} onClick={() => setMenuOpen(false)}>
            {dict.header.open}
          </a>
        </nav>

        <button
          ref={toggleRef}
          type="button"
          className="menu-toggle"
          aria-label={menuOpen ? dict.header.menuCloseAria : dict.header.menuOpenAria}
          aria-expanded={menuOpen}
          aria-controls="site-nav"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>
      </div>
    </header>
  );
}
