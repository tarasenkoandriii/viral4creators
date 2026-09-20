'use client';

import { useEffect } from 'react';
import type { Locale } from '../lib/i18n';

/**
 * `<html lang>` рендерится один раз в настоящем корневом layout
 * (app/layout.tsx) — тот же обход, что в landing/src/components/SetHtmlLang.tsx,
 * см. его комментарий для полного обоснования.
 */
export function SetHtmlLang({ locale }: { locale: Locale }) {
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return null;
}
