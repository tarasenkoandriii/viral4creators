'use client';

import { useEffect } from 'react';

/**
 * Полевые CWV (`web-vitals`, ТЗ §9 п.7). Библиотека грузится отдельным
 * чанком ПОСЛЕ гидратации — в JS первой загрузки её нет; наблюдатели
 * `web-vitals` читают буферизованные записи, так что поздняя
 * регистрация LCP/CLS не теряет. Отправка — `sendBeacon` при скрытии
 * страницы (так делает сама библиотека для INP/CLS).
 */
export function WebVitals() {
  useEffect(() => {
    let cancelled = false;
    import('web-vitals').then(({ onCLS, onINP, onLCP, onFCP, onTTFB }) => {
      if (cancelled) return;
      const send = (metric: { name: string; value: number; rating: string }) => {
        const body = JSON.stringify({ name: metric.name, value: metric.value, rating: metric.rating, path: location.pathname });
        if (!navigator.sendBeacon?.('/api/vitals', new Blob([body], { type: 'application/json' }))) {
          fetch('/api/vitals', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {});
        }
      };
      onCLS(send);
      onINP(send);
      onLCP(send);
      onFCP(send);
      onTTFB(send);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
