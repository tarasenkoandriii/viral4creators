import { useId, useState } from 'react';
import {
  CalendarPlus,
  Copy,
  Mail,
  MessageCircle,
  Send,
  Share2,
} from 'lucide-react';
import { Alert, Button, Card, Field, Input } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { INTL_LOCALE } from '../../lib/intl-locale';
import { getTelegramWebApp, openTelegramLink } from '../../lib/telegram';
import { GreetingQrCode } from './GreetingQrCode';
import type { Dictionary } from '../../lib/get-dictionary';
import {
  deliveryMessage,
  mailtoUrl,
  reminderDateFor,
  reminderIcs,
  telegramShareUrl,
  whatsappShareUrl,
} from './greeting-delivery';

/**
 * «Вручить поздравление» — фича №26 компаньон-ТЗ, этап 4 плана.
 *
 * До этой панели мастер заканчивался плеером и кнопкой «Скачать»: у
 * поздравления, весь смысл которого — быть вручённым, не было ни одного
 * способа дойти до получателя, кроме «скачай файл и отправь сам».
 *
 * Отправляется ссылка на сам ролик, а не публичная страница `/video/:id`:
 * та ждёт одобрения оператором, а поздравление бабушке ждать модератора
 * не может (обоснование целиком — в `greeting-delivery.ts`).
 *
 * Повторная выдача ссылки (фича №24) отдельной кнопкой НЕ делается и не
 * нужна: мастер восстанавливает последнюю сессию проекта при каждом
 * открытии (`listGreetingSessions` → `sessionId` → `VideoStep`), то есть
 * человек, потерявший ссылку, просто заходит в проект и видит эту же
 * панель.
 *
 * Внутри Telegram шаринг идёт через `openTelegramLink` — иначе родной
 * выбор чата подменяется веб-версией телеграма внутри нашего же окна.
 * Вне Telegram (обычный браузер) той же ссылке достаточно новой вкладки.
 */
export function GreetingDeliveryPanel({
  dict,
  videoUrl,
  recipientName,
  senderName,
  occasionDate,
}: {
  dict: Dictionary;
  videoUrl: string;
  recipientName: string;
  senderName?: string | null;
  /** Дата повода из брифа (`YYYY-MM-DD`) — от неё считается напоминание. */
  occasionDate?: string | null;
}) {
  const t = dict.greetingDelivery;
  const { locale } = useI18n();
  const [copied, setCopied] = useState(false);
  // Буфер обмена запрещён (политика страницы, старый webview Telegram) —
  // ссылка показывается полем, откуда её можно скопировать руками
  // (CONTRACT6 G-FE п. 9). Раньше сбой молча глотался.
  const [manualCopy, setManualCopy] = useState(false);
  const linkFieldId = useId();
  const message = deliveryMessage(t.messageTemplate, recipientName, senderName);

  const openExternal = (url: string) => {
    const tg = getTelegramWebApp();
    if (tg?.openLink) tg.openLink(url);
    else window.open(url, '_blank', 'noopener');
  };

  const sendToTelegram = () => {
    // Тот же помощник, что у кабинета «Пригласить» (этап 133): второе
    // место с тем же приёмом — повод вынести его, а не скопировать.
    openTelegramLink(telegramShareUrl(videoUrl, message));
  };

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(videoUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setManualCopy(true);
    }
  };

  /** Системный лист шаринга — только там, где он действительно есть. */
  const nativeShare =
    typeof navigator !== 'undefined' && typeof navigator.share === 'function'
      ? async () => {
          try {
            await navigator.share({ text: message, url: videoUrl });
          } catch {
            // Человек закрыл системное окно — это не ошибка.
          }
        }
      : null;

  /**
   * Фича №25 в переформулировке аудита (находка 1.10): напоминание
   * ОТПРАВИТЕЛЮ, а не мнимый «календарь получателя».
   *
   * Файл, а не ссылка на чужой календарь: `.ics` открывается любым
   * календарём, включая офлайновый, и не требует у человека ни одного
   * разрешения на доступ к его данным.
   */
  const remind = reminderDateFor(occasionDate, new Date());
  const remindDate = remind.date;
  const downloadReminder = () => {
    const ics = reminderIcs({
      summary: t.remindSummary.replace('{recipient}', recipientName.trim()),
      description: t.remindDescription,
      date: remindDate,
    });
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = 'greeting-reminder.ics';
    a.click();
    // Освобождаем объектный адрес сразу: страница живёт долго, а файл
    // уже забран (тот же приём, что в lib/object-url.ts).
    setTimeout(() => URL.revokeObjectURL(href), 0);
  };

  return (
    <Card className="p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{t.title}</h3>
        <p className="mt-1 text-xs text-[var(--muted)]">{t.hint}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<Send size={14} />} onClick={sendToTelegram}>
          {t.telegram}
        </Button>
        <Button
          size="sm"
          variant="outline"
          icon={<MessageCircle size={14} />}
          onClick={() => openExternal(whatsappShareUrl(videoUrl, message))}
        >
          {t.whatsapp}
        </Button>
        <Button
          size="sm"
          variant="outline"
          icon={<Mail size={14} />}
          onClick={() =>
            openExternal(mailtoUrl(t.mailSubject, message, videoUrl))
          }
        >
          {t.email}
        </Button>
        {nativeShare && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Share2 size={14} />}
            onClick={() => void nativeShare()}
          >
            {t.systemShare}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={<Copy size={14} />}
          onClick={() => void copy()}
        >
          {copied ? t.copied : t.copyLink}
        </Button>
      </div>

      {manualCopy && (
        <Field
          label={dict.greetingUi.copyManualLabel}
          hint={dict.greetingUi.copyManualHint}
          htmlFor={linkFieldId}
        >
          <Input
            id={linkFieldId}
            readOnly
            value={videoUrl}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
          />
        </Field>
      )}

      {/* Цена решения названа прямо, а не спрятана в справку: ссылка
          открывается без входа, и в кадре — имя получателя. Человек
          вправе знать это ДО того, как перешлёт её в общий чат. */}
      <Alert tone="info">{t.publicWarning}</Alert>

      {/* Фича №21 — вручить физически. Рядом с цифровыми каналами, но
          ниже: это меньшинство случаев, и кнопка не должна спорить за
          внимание с «отправить в телеграм». */}
      <div className="border-t border-[var(--border)] pt-4">
        <GreetingQrCode dict={dict} url={videoUrl} />
      </div>

      <div className="border-t border-[var(--border)] pt-4">
        <Button
          size="sm"
          variant="ghost"
          icon={<CalendarPlus size={14} />}
          onClick={downloadReminder}
        >
          {t.remindButton}
        </Button>
        {/* Дата повода есть в брифе — от неё; нет — допущение «год от
            сегодня», и об этом сказано человеку, а не только в коде.
            Формат даты — по языку интерфейса, а не браузера. */}
        <p className="mt-2 text-xs text-[var(--muted)]">
          {(remind.fromOccasion
            ? dict.greetingUi.remindHintOccasion
            : t.remindHint
          ).replace(
            '{date}',
            remindDate.toLocaleDateString(INTL_LOCALE[locale] ?? 'ru-RU', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              timeZone: 'UTC',
            })
          )}
        </p>
      </div>
    </Card>
  );
}
