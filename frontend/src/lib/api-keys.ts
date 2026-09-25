/**
 * Ключи внешнего API — чистые правила экрана (этап 145,
 * docs-tz/TZ-Vneshnee-API.md).
 *
 * Отдельно от экрана, потому что проверяются без React: у фронтенда
 * тесты — обычные скрипты (`frontend/scripts/*.test.ts`), и всё, что
 * можно вынести из компонента, проверяется ими, а не глазами.
 */

export interface ApiKeyView {
  id: string;
  name: string;
  /** Куда сообщать об исходе заявки (этап 146). Пусто — не сообщать. */
  webhookUrl: string | null;
  /** Открытое начало ключа: `v4c_` плюс восемь символов. */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type ApiKeyStatus = 'revoked' | 'unused' | 'active';

/**
 * Состояние строки. «Ни разу не использован» — отдельное от «работает»
 * намеренно: это единственная подсказка человеку, что он сохранил ключ
 * и забыл его куда-то вставить, а с виду всё в порядке.
 */
export function statusOf(key: ApiKeyView): ApiKeyStatus {
  if (key.revokedAt) return 'revoked';
  return key.lastUsedAt ? 'active' : 'unused';
}

/** Живые сверху, отозванные вниз; внутри — новые раньше старых. */
export function sortKeys(keys: ApiKeyView[]): ApiKeyView[] {
  return [...keys].sort((a, b) => {
    const revoked = Number(Boolean(a.revokedAt)) - Number(Boolean(b.revokedAt));
    if (revoked !== 0) return revoked;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** Сколько ключей ещё можно выдать. Ноль — кнопка выключена. */
export function slotsLeft(keys: ApiKeyView[], max: number): number {
  const active = keys.filter((k) => !k.revokedAt).length;
  return Math.max(max - active, 0);
}

/**
 * Жив ли ещё показанный секрет (аудит этапа 145).
 *
 * Он живёт ТОЛЬКО в памяти экрана: ни `localStorage`, ни адресной
 * строки — иначе «показан один раз» перестаёт быть правдой ровно тогда,
 * когда это важно. Уход с экрана уносит его вместе с компонентом.
 *
 * Первая редакция стирала секрет при ЛЮБОЙ перезагрузке списка и
 * называла это заботой: мол, человек сразу поймёт, что второго шанса
 * нет. Но перезагрузку запускает не он — её запускают отзыв соседнего
 * ключа и кнопка «повторить» после сетевой осечки, и обе уносили
 * единственную копию ключа, за которую он ещё не успел взяться.
 * Обещание «показан один раз» — про сервер, который больше его не
 * покажет, а не про наш экран, который спешит забыть.
 *
 * Поэтому убирает секрет только сам человек.
 */
export function keepSecret(
  secret: string | null,
  event: 'issued' | 'reloaded' | 'dismissed'
): string | null {
  return event === 'dismissed' ? null : secret;
}
