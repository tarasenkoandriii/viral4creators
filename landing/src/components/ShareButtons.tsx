'use client';

import { useState } from 'react';

/**
 * «Поделиться» на публичной странице ролика (ТЗ §40, этап 60). Сама
 * страница — серверный компонент (generateMetadata требует async), а
 * `navigator.share`/`navigator.clipboard` работают только в браузере —
 * поэтому кнопка вынесена в свой маленький клиентский компонент, как и
 * `LocaleSwitcher`.
 */
export function ShareButtons({
  url,
  title,
  label,
  copiedLabel,
}: {
  url: string;
  title: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const share = async () => {
    try {
      if (navigator.share) {
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

  return (
    <button type="button" className="cta cta-ghost" onClick={() => void share()}>
      {copied ? copiedLabel : label}
    </button>
  );
}
