'use client';

// Пользователь вместо голого id (cmtvyn7cd000504jm8whsu5d8): кружок-аватар,
// @username / имя / tg <telegramId>, ссылка в «Пользователи». Данные —
// через батч-кеш lib/user-briefs.ts: сколько бы бейджей ни было на экране,
// запрос за подписями один.

import { useEffect, useState, useSyncExternalStore, type MouseEvent } from 'react';
import Link from 'next/link';
import { briefInitial, briefLabel, canHaveAvatar, isUserId, userBriefs } from '../lib/user-briefs';

const AVATAR_PX = 20;

function useBrief(id: string | null) {
  const store = userBriefs();
  const brief = useSyncExternalStore(
    store.subscribe,
    () => (id ? store.getBrief(id) : undefined),
    // На сервере кеша нет — первая отрисовка всегда «ещё не знаем».
    () => undefined,
  );
  const avatar = useSyncExternalStore(
    store.subscribe,
    () => (id ? store.getAvatar(id) : undefined),
    () => undefined,
  );
  useEffect(() => {
    if (id) store.requestBrief(id);
  }, [id, store]);
  useEffect(() => {
    if (id && canHaveAvatar(brief)) store.requestAvatar(id);
  }, [id, brief, store]);
  return { brief, avatar };
}

/** Только кружок — для строк, где имя уже написано рядом (список пользователей). */
export function UserAvatar({ userId }: { userId: string }) {
  const { brief, avatar } = useBrief(isUserId(userId) ? userId : null);
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        width: AVATAR_PX,
        height: AVATAR_PX,
        borderRadius: '50%',
        overflow: 'hidden',
        background: 'var(--border)',
        color: 'var(--fg)',
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1,
        verticalAlign: 'middle',
      }}
    >
      {avatar ? (
        // eslint-disable-next-line @next/next/no-img-element -- object URL из fetch, next/image тут ни к чему
        <img src={avatar} alt="" width={AVATAR_PX} height={AVATAR_PX} style={{ objectFit: 'cover' }} />
      ) : (
        briefInitial(brief)
      )}
    </span>
  );
}

export interface UserBadgeProps {
  /** id пользователя; служебные значения (`vercel-cron`, `proactive`) и
   *  пустое показываются как есть, без запроса. */
  userId: string | null | undefined;
  /** Что показать вместо пустого значения. */
  empty?: string;
  /** Ссылка на пользователя в «Пользователях» (по умолчанию да). */
  link?: boolean;
  /** Кнопка «скопировать полный id» (по умолчанию да). */
  copy?: boolean;
}

export default function UserBadge({ userId, empty = '—', link = true, copy = true }: UserBadgeProps) {
  const id = isUserId(userId) ? userId : null;
  const { brief } = useBrief(id);
  const [copied, setCopied] = useState(false);

  if (!id) return <span>{userId || empty}</span>;

  const label = briefLabel(id, brief);
  const title = brief ? `id ${id}\ntelegramId ${brief.telegramId}` : `id ${id}`;
  // Карточки пользователя отдельной страницей нет — «Пользователи» ищут
  // по telegramId/@username/имени (не по id), поэтому ссылка — поиск по
  // telegramId, и только когда он уже известен.
  const href = link && brief ? `/users?q=${encodeURIComponent(brief.telegramId)}` : null;

  const onCopy = (e: MouseEvent) => {
    // Бейдж бывает внутри кликабельной строки таблицы — клик по кнопке
    // не должен её открывать.
    e.stopPropagation();
    void navigator.clipboard?.writeText(id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <span
      title={title}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', verticalAlign: 'middle' }}
    >
      <UserAvatar userId={id} />
      {href ? (
        <Link href={href} onClick={(e) => e.stopPropagation()}>
          {label}
        </Link>
      ) : (
        <span>{label}</span>
      )}
      {copy && (
        <button
          type="button"
          onClick={onCopy}
          aria-label={`Скопировать id ${id}`}
          title="Скопировать полный id"
          style={{ padding: '0 4px', fontSize: 11, lineHeight: '16px', minHeight: 0 }}
        >
          {copied ? '✓' : '⧉'}
        </button>
      )}
    </span>
  );
}
