'use client';

/**
 * Лайк под видео (ТЗ §11.1) — доступен любому залогиненному пользователю,
 * не только участникам сделки, которой на Этапе 0 и нет.
 *
 * Аудит-фикс: initialLiked приходит с сервера (lib/api.ts), который не
 * прокидывает cookie посетителя и кеширует ответ на всех сразу — то есть
 * initialLiked ВСЕГДА false, даже если человек уже лайкал. При монтировании
 * дергаем credentialed клиентский запрос и перезаписываем состояние
 * настоящим — если посетитель не вошёл, запрос просто вернёт то же
 * false, разницы не будет.
 */

import { useEffect, useState } from 'react';
import { getPortfolioItemLikeState, likePortfolioItem, unlikePortfolioItem } from '../lib/client-api';
import { useDictionary } from '../lib/dictionary-context';

export function LikeButton({
  itemId,
  initialCount,
  initialLiked,
}: {
  itemId: string;
  initialCount: number;
  initialLiked: boolean;
}) {
  const { dict } = useDictionary();
  const [count, setCount] = useState(initialCount);
  const [liked, setLiked] = useState(initialLiked);
  const [busy, setBusy] = useState(false);
  const [notLoggedIn, setNotLoggedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPortfolioItemLikeState(itemId)
      .then((fresh) => {
        if (cancelled) return;
        setLiked(fresh.likedByViewer);
        setCount(fresh.likeCount);
      })
      .catch(() => {
        // Публичный эндпоинт не должен падать; если упал — оставляем
        // серверный (заведомо «не лайкнуто») вариант как есть.
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setNotLoggedIn(false);
    const nextLiked = !liked;
    setLiked(nextLiked);
    setCount((c) => c + (nextLiked ? 1 : -1));
    try {
      const result = nextLiked ? await likePortfolioItem(itemId) : await unlikePortfolioItem(itemId);
      setLiked(result.likedByViewer);
      setCount(result.likeCount);
    } catch {
      // Аудит-фикс: раньше откат был молчаливым — человек не понимал,
      // почему клик «не сработал». Показываем короткую подсказку войти.
      setLiked(!nextLiked);
      setCount((c) => c + (nextLiked ? -1 : 1));
      setNotLoggedIn(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button type="button" className="mp-like-button" data-liked={liked} onClick={() => void toggle()}>
        {liked ? '♥' : '♡'} {count}
      </button>
      {notLoggedIn && (
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{dict.share.loginToLike}</span>
      )}
    </span>
  );
}
