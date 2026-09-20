'use client';

/**
 * Встраиваемый виджет портфолио (ТЗ §20 №5) — код для вставки на личный
 * сайт исполнителя. Сама встраиваемая страница — src/app/embed/[id]/page.tsx
 * (вне [locale], без локализации — см. lib/i18n.ts).
 */

import { useState } from 'react';
import { useDictionary } from '../lib/dictionary-context';

export function EmbedSnippet({ creatorId }: { creatorId: string }) {
  const { dict } = useDictionary();
  const [copied, setCopied] = useState(false);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3004';
  const snippet = `<iframe src="${siteUrl}/embed/${creatorId}" width="100%" height="600" style="border:0;border-radius:12px;" loading="lazy"></iframe>`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // буфер обмена недоступен — код всё равно виден на странице
    }
  };

  return (
    <div>
      <textarea readOnly rows={3} value={snippet} className="mp-filter-input" style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }} />
      <button type="button" className="mp-cta-secondary" onClick={() => void copy()} style={{ marginTop: 8 }}>
        {copied ? dict.embedSnippet.copied : dict.embedSnippet.copyButton}
      </button>
    </div>
  );
}
