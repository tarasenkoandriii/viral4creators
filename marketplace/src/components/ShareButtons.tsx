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
      // Аудит-фикс: Web Share API (navigator.share) не объявлен в типе
      // Navigator этой версии lib.dom.d.ts. Раньше здесь стояло
      // `'share' in navigator` — сочетание `in`-проверки свойства,
      // отсутствующего в типе, с безусловным return внутри if сузило тип
      // navigator в остальном коде до never (реальная причина падения
      // сборки — "Property 'clipboard' does not exist on type 'never'").
      // Проверяем через приведение типа локальной переменной, не трогая
      // тип глобального navigator.
      const nav = navigator as Navigator & { share?: (data: { title?: string; url?: string }) => Promise<void> };
      if (nav.share) {
        await nav.share({ title, url });
        return;
      }
      if (!navigator.clipboard) {
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
