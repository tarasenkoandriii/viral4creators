import { createHash } from 'node:crypto';

/**
 * Лимит заявок пилота — в памяти экземпляра функции.
 *
 * Честно о границах (как §6.3 ТЗ про песочницу: «чем лимиты НЕ являются»):
 * на Vercel экземпляров может быть несколько, и каждый считает сам, —
 * это не стена, а ступенька, отсекающая повторную отправку и простой
 * скрипт. Стены тут и не нужно: заявка ничего не стоит, кроме сообщения
 * в служебный канал, а у Telegram свой лимит на бота. Общий счётчик
 * (KV/Redis) появится вместе с `sites-backend`-событиями, если спама
 * станет больше, чем ручного разбора.
 *
 * Ключ — хеш адреса с суточной солью; для IPv6 — по префиксу /64 (у
 * одного абонента IPv6 миллиарды адресов, урок §6.3). Сам адрес не
 * хранится нигде, хеш — только в памяти на время окна.
 */
export const PILOT_RATE = {
  /** Заявок с одного адреса за окно. */
  perKey: 3,
  windowMs: 10 * 60 * 1000,
  /** Заявок на экземпляр за час — от потока с разных адресов. */
  globalPerHour: 30,
} as const;

export function clientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  const first = xff?.split(',')[0]?.trim();
  return first || headers.get('x-real-ip')?.trim() || 'unknown';
}

/** IPv6 → первые 4 группы (/64); IPv4 и прочее — как есть. */
export function ipKeyPart(ip: string): string {
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups
    .slice(0, 4)
    .map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':') + '::/64';
}

export function rateKey(ip: string, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return createHash('sha256').update(`${ipKeyPart(ip)}|${day}|pilot`).digest('hex').slice(0, 32);
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private global: number[] = [];

  constructor(private readonly limits: { perKey: number; windowMs: number; globalPerHour: number } = PILOT_RATE) {}

  /** true — можно; false — лимит. Засчитывает попытку только при «можно». */
  take(key: string, now: number = Date.now()): boolean {
    const fresh = (this.hits.get(key) ?? []).filter((t) => now - t < this.limits.windowMs);
    this.global = this.global.filter((t) => now - t < 60 * 60 * 1000);
    if (fresh.length >= this.limits.perKey || this.global.length >= this.limits.globalPerHour) {
      this.hits.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.set(key, fresh);
    this.global.push(now);
    if (this.hits.size > 5000) this.sweep(now);
    return true;
  }

  private sweep(now: number) {
    for (const [k, list] of this.hits) {
      if (list.every((t) => now - t >= this.limits.windowMs)) this.hits.delete(k);
    }
  }
}
