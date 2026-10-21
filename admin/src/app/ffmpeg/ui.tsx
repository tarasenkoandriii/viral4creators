'use client';

// Мелкие общие элементы вкладки «FFmpeg»: бейдж, подпись свежести,
// баннер недоступного источника. Цвет никогда не единственный носитель
// смысла — рядом всегда текст.
import type { ReactNode } from 'react';
import { kyivTime, type Freshness } from '../../lib/ffmpeg';

export type Tone = 'ok' | 'warning' | 'critical' | 'neutral' | 'accent';

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  // Длинные подписи («восстановление: приём закрыт до сверки») переносятся: на 320px nowrap общего класса вылезал за экран.
  return (
    <span className={`badge-status badge-status-${tone}`} style={{ whiteSpace: 'normal', maxWidth: '100%' }}>
      {children}
    </span>
  );
}

const FRESH_TEXT: Record<Freshness, string> = {
  fresh: 'актуально',
  stale: 'устарело',
  missing: 'нет данных',
};
const FRESH_TONE: Record<Freshness, Tone> = { fresh: 'ok', stale: 'warning', missing: 'critical' };

/** Момент наблюдения и свежесть значения: «на 12.10 14:03:05 · устарело». */
export function Observed({ at, fresh }: { at: string | null | undefined; fresh: Freshness }) {
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 12 }}>
      <span className="muted">{at ? `на ${kyivTime(at)}` : 'время неизвестно'}</span>
      {fresh !== 'fresh' && <Badge tone={FRESH_TONE[fresh]}>{FRESH_TEXT[fresh]}</Badge>}
    </span>
  );
}

/** Источник не ответил: явно, а не пустая таблица. */
export function StaleBanner({ title, reason, at }: { title: string; reason: string | null | undefined; at: string | null | undefined }) {
  return (
    <div className="rx-alert rx-alert-warning" role="alert" style={{ marginBottom: 12 }}>
      <span className="rx-alert-title">{title}</span>
      <span>
        {reason ? (/[.!?…]$/.test(reason) ? reason : `${reason}.`) : 'Причина не сообщена.'} {at ? `Показаны последние известные данные на ${kyivTime(at)}.` : 'Последних известных данных нет.'}
      </span>
    </div>
  );
}

export function ErrorLine({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="rx-alert rx-alert-danger" role="alert" style={{ marginBottom: 12 }}>
      <span>{text}</span>
      {onRetry && (
        <span>
          <button type="button" onClick={onRetry}>
            Повторить
          </button>
        </span>
      )}
    </div>
  );
}
