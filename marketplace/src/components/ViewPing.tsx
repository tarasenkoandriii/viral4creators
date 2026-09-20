'use client';

/**
 * Счётчик просмотров (ТЗ §20 №13) — best-effort инкремент при открытии
 * страницы, тот же принцип, что у SharedVideoPage.viewCount. Рендерит
 * null: чистый side-effect, без разметки, чтобы не влиять на SSR-разметку
 * страницы (важно для не-мигающего SEO-контента).
 */

import { useEffect, useRef } from 'react';
import { recordCreatorView, recordPortfolioView } from '../lib/client-api';

export function ViewPing({ kind, id }: { kind: 'creator' | 'portfolio-item'; id: string }) {
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    void (kind === 'creator' ? recordCreatorView(id) : recordPortfolioView(id));
  }, [kind, id]);

  return null;
}
