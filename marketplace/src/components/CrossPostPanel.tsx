'use client';

/**
 * Кросспостинг работы (ТЗ §20 №4) — честная реализация того, что реально
 * доступно без OAuth-интеграции с каждой площадкой (см. полный разбор
 * в комментарии предыдущей версии файла в истории). Строки — из словаря.
 */

import { useState } from 'react';
import { useDictionary } from '../lib/dictionary-context';

export function CrossPostPanel({ videoUrl, title }: { videoUrl: string; title: string }) {
  const { dict } = useDictionary();
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const caption = `${title} ${videoUrl}`;

  const copyAndOpen = async (platform: string, openUrl: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(caption);
        setCopiedFor(platform);
        setTimeout(() => setCopiedFor(null), 2500);
      }
    } catch {
      // буфер обмена недоступен — всё равно открываем площадку
    }
    window.open(openUrl, '_blank', 'noopener,noreferrer');
  };

  const tweetIntent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(caption)}`;

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <a className="mp-cta-secondary" href={tweetIntent} target="_blank" rel="noreferrer">
        {dict.crossPost.x}
      </a>
      <button
        type="button"
        className="mp-cta-secondary"
        onClick={() => void copyAndOpen('Instagram', 'https://www.instagram.com/')}
      >
        {copiedFor === 'Instagram' ? dict.crossPost.copied : dict.crossPost.instagram}
      </button>
      <button
        type="button"
        className="mp-cta-secondary"
        onClick={() => void copyAndOpen('TikTok', 'https://www.tiktok.com/upload')}
      >
        {copiedFor === 'TikTok' ? dict.crossPost.copied : dict.crossPost.tiktok}
      </button>
      <p className="mp-hint" style={{ width: '100%' }}>
        {dict.crossPost.hint}
      </p>
    </div>
  );
}
