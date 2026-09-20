'use client';

/**
 * QR-код профиля для офлайн-нетворкинга (ТЗ §20 №6). Рендерится через
 * публичный сервис api.qrserver.com — генерировать QR на клиенте своими
 * силами означало бы новую зависимость (нет сети на npm install в
 * песочнице, где писался код, чтобы её поставить и проверить); внешний
 * сервис — сознательный компромисс, а не тихая заглушка. Если это
 * неприемлемо для продакшена — заменить на самостоятельную генерацию
 * (например, библиотекой qrcode) без изменений остального кода.
 */

import { useDictionary } from '../lib/dictionary-context';

export function QrCode({ data, size = 180 }: { data: string; size?: number }) {
  const { dict } = useDictionary();
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(data)}`;
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={dict.qr.alt}
      style={{ borderRadius: 8, background: '#fff', padding: 8 }}
    />
  );
}
