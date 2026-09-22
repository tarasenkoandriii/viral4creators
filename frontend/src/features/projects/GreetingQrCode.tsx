import { useEffect, useState } from 'react';
import { QrCode as QrIcon } from 'lucide-react';
import { Button } from '../../components/ui';
import type { Dictionary } from '../../lib/get-dictionary';

/**
 * QR-код на ролик — фича №21 компаньон-ТЗ: для тех, кто вручает
 * поздравление физически (открытка, коробка, подарок в руки).
 *
 * ## Почему НЕ переиспользован `marketplace/src/components/QrCode.tsx`
 *
 * Тот рисует QR через внешний сервис `api.qrserver.com`, отправляя ему
 * кодируемую строку. Для ссылки на профиль исполнителя это приемлемый
 * компромисс, и он там честно описан в доккомментарии. Здесь — нет: в
 * строке лежит адрес, который ОТКРЫВАЕТ личное видео, где звучит имя
 * получателя. Отправить его стороннему сервису значит отдать ключ от
 * чужого поздравления третьей стороне и положиться на её логи.
 *
 * Поэтому код рисуется на месте, библиотекой `qrcode` — 260 КБ в
 * node_modules и ноль сетевых запросов. Ровно тот случай, который
 * доккомментарий маркетплейса и предусматривал («если это неприемлемо
 * для продакшена — заменить на самостоятельную генерацию»).
 *
 * Генерация ленивая: библиотека тянется динамическим импортом и только
 * после нажатия. Большинство отправителей вручают ссылку, а не
 * распечатку, — грузить кодировщик всем ради меньшинства незачем.
 */
export function GreetingQrCode({
  dict,
  url,
}: {
  dict: Dictionary;
  url: string;
}) {
  const t = dict.greetingDelivery;
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || dataUrl) return;
    let cancelled = false;
    void (async () => {
      try {
        const { toDataURL } = await import('qrcode');
        const png = await toDataURL(url, {
          width: 320,
          margin: 2,
          // Белый фон и чёрный рисунок: QR печатают, а печать не знает
          // про тёмную тему интерфейса.
          color: { dark: '#000000', light: '#ffffff' },
          // Средний уровень коррекции — код переживает сгиб открытки,
          // не раздуваясь в размере, как при высоком.
          errorCorrectionLevel: 'M',
        });
        if (!cancelled) setDataUrl(png);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, url, dataUrl]);

  if (!open) {
    return (
      <Button
        size="sm"
        variant="ghost"
        icon={<QrIcon size={14} />}
        onClick={() => setOpen(true)}
      >
        {t.qrButton}
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      {dataUrl ? (
        <img
          src={dataUrl}
          width={160}
          height={160}
          alt={t.qrAlt}
          className="rounded-lg"
        />
      ) : failed ? (
        <p className="text-xs text-[var(--muted)]">{t.qrFailed}</p>
      ) : (
        <p className="text-xs text-[var(--muted)]">{t.qrLoading}</p>
      )}
      <p className="text-xs text-[var(--muted)]">{t.qrHint}</p>
    </div>
  );
}
