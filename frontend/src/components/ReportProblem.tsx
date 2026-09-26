/**
 * Форма «Сообщить о проблеме» (этап 160, §3.8 ТЗ на работу с
 * тестировщиком).
 *
 * Видна только тестировщику, и это не украшение: поддержка для всех —
 * другой продукт с другой нагрузкой, и делать её под видом тикетов
 * тестировщика значит получить её неготовой.
 *
 * Сессия и шаг подставляются сами — из `report-location.ts`, куда их
 * сообщает мастер. Человеку показывают, ЧТО именно приложится: скрытая
 * подстановка в отчёте о баге читается как слежка, а видимая — как
 * помощь.
 */

import { useState } from 'react';
import type { Dictionary } from '../lib/get-dictionary';
import { useReportLocation } from '../lib/report-location';
import {
  createTicket,
  uploadTicketFile,
  type TicketAttachmentRef,
} from '../services/tickets-api';

/** Тот же потолок, что на сервере, — но здесь он экономит ожидание. */
const MAX_BYTES = 10 * 1024 * 1024;

export function ReportProblem({
  dict,
  locale,
  onClose,
}: {
  dict: Dictionary;
  locale: string;
  onClose: () => void;
}) {
  const t = dict.reportProblem;
  const where = useReportLocation();
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  /**
   * Уже загруженный файл (аудит этапа 160). Отправка — это два шага, и
   * если второй не удался, повтор не должен грузить файл заново:
   * первая копия осталась бы в хранилище навсегда, никем не
   * упомянутая. Один сорвавшийся показ — один файл, а не по одному на
   * каждое нажатие «Отправить».
   */
  const [uploaded, setUploaded] = useState<TicketAttachmentRef | null>(null);

  const pick = (chosen: File | null) => {
    if (chosen && chosen.size > MAX_BYTES) {
      // До загрузки, а не после: сказать о потолке, когда человек уже
      // прождал отправку, — самый дорогой способ об этом сообщить.
      setError(t.tooBig);
      return;
    }
    setError(null);
    setFile(chosen);
    // Выбрали другой файл — прежняя загрузка больше не та.
    setUploaded(null);
  };

  const send = async () => {
    if (!text.trim() && !file) {
      setError(t.empty);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let ref = uploaded;
      if (file && !ref) {
        ref = await uploadTicketFile(file);
        setUploaded(ref);
      }
      const attachments: TicketAttachmentRef[] = ref ? [ref] : [];
      const { number } = await createTicket({
        text: text.trim(),
        uiLocale: locale,
        sessionId: where.sessionId,
        stepId: where.stepId,
        attachments,
      });
      setDone(number);
    } catch {
      setError(t.failed);
    } finally {
      setBusy(false);
    }
  };

  const place = [where.sessionId, where.stepId].filter(Boolean).join(' · ');

  /**
   * Нажатие мимо карточки закрывает форму, только пока в ней ничего
   * нет (аудит этапа 160).
   *
   * Тёмное поле вокруг занимает почти весь экран, а внутри — текст,
   * который человек только что набрал руками. Закрывать по случайному
   * касанию форму, ради набранного текста и существующую, — потерять
   * ровно то, что она собирает. Явная кнопка «Отмена» рядом и никуда
   * не делась.
   */
  const closeOnBackdrop = () => {
    if (text.trim() || file) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center"
      onClick={closeOnBackdrop}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-silver-50 p-4 text-sm dark:bg-silver-950"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{t.title}</h2>

        {done !== null ? (
          <>
            <p className="mt-3">{t.sent.replace('{number}', String(done))}</p>
            {/* «Закрыть», а не «Отмена» (аудит этапа 160): находка уже
                принята, и слово «отмена» на этом экране предлагает
                отменить именно её. */}
            <button
              type="button"
              className="mt-4 min-h-[44px] w-full rounded-xl bg-accent px-4 font-medium text-white"
              onClick={onClose}
            >
              {t.close}
            </button>
          </>
        ) : (
          <>
            <p className="mt-1 text-[12px] opacity-60">{t.hint}</p>
            <textarea
              className="mt-3 w-full rounded-xl border border-silver-300 bg-transparent p-3 dark:border-silver-700"
              rows={5}
              placeholder={t.placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={busy}
            />

            {/* Видно, что приложится. Скрытая подстановка в отчёте о
                баге читается как слежка, видимая — как помощь. */}
            {place && (
              <p className="mt-1 text-[11px] opacity-50">
                {t.here.replace('{where}', place)}
              </p>
            )}

            <label className="mt-3 flex min-h-[44px] items-center gap-2 text-[13px]">
              <input
                type="file"
                className="hidden"
                onChange={(e) => pick(e.target.files?.[0] ?? null)}
                disabled={busy}
              />
              <span className="cursor-pointer underline">
                {file ? `${t.attached}: ${file.name}` : t.attach}
              </span>
            </label>

            {error && <p className="mt-2 text-[13px] text-red-500">{error}</p>}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="min-h-[44px] flex-1 rounded-xl bg-accent px-4 font-medium text-white disabled:opacity-50"
                onClick={() => void send()}
                disabled={busy}
              >
                {busy ? t.sending : t.send}
              </button>
              <button
                type="button"
                className="min-h-[44px] rounded-xl px-4 underline"
                onClick={onClose}
                disabled={busy}
              >
                {t.cancel}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
