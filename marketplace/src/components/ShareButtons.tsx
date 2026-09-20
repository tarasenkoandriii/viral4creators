'use client';

/**
 * «Поделиться» (ТЗ §20 №2, №14) — тот же паттерн, что уже отработан в
 * landing/src/components/ShareButtons.tsx. Строки — из словаря (§20 №15).
 */

import { useState } from 'react';
import { useDictionary } from '../lib/dictionary-context';

export function ShareButtons({ url, title }: { url: string; title: string }) {
  const { dict } = useDictionary();
  const [copied, setCopied] = useState(false);

  const share = async () => {
    try {
      if (typeof navigator !== 'undefined' && 'share' in navigator) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Пользователь закрыл системный шаринг — не ошибка.
    }
  };

  const telegramShareUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`;
  const whatsappShareUrl = `https://wa.me/?text=${encodeURIComponent(`${title} ${url}`)}`;

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button type="button" className="mp-cta-secondary" onClick={() => void share()}>
        {copied ? dict.share.linkCopied : dict.share.shareOrCopy}
      </button>
      <a className="mp-cta-secondary" href={telegramShareUrl} target="_blank" rel="noreferrer">
        {dict.share.telegram}
      </a>
      <a className="mp-cta-secondary" href={whatsappShareUrl} target="_blank" rel="noreferrer">
        {dict.share.whatsapp}
      </a>
    </div>
  );
}
