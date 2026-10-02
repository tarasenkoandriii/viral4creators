/**
 * Шифр `identify` посетителя в передаче (К-3: данные покупателя — только с
 * явной передачей, в открытом виде нигде) — H. Ключ — тот же производный
 * ключ полей лида (`leadKey`, ASSIST_SECRETS_KEY), AES-256-GCM; связка с id
 * передачи (AAD) — шифр одной передачи нельзя подложить в другую. Чистый
 * модуль: шифрует публичный приём, расшифровывает системная рассылка.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { WidgetIdentity } from '../../assist-site-chat/chat-types';

const AAD_PREFIX = 'assist-handoff-identity:';

export function encryptIdentity(
  identity: WidgetIdentity,
  handoffId: string,
  key: Buffer,
): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`${AAD_PREFIX}${handoffId}`, 'utf8'));
  const enc = Buffer.concat([
    c.update(JSON.stringify(identity), 'utf8'),
    c.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    c.getAuthTag().toString('base64url'),
    enc.toString('base64url'),
  ].join('.');
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;

/** null — чужой ключ, порча, чужая передача (без исключения и без текста в лог). */
export function decryptIdentity(
  blob: string,
  handoffId: string,
  key: Buffer,
): WidgetIdentity | null {
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const d = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parts[1], 'base64url'),
    );
    d.setAAD(Buffer.from(`${AAD_PREFIX}${handoffId}`, 'utf8'));
    d.setAuthTag(Buffer.from(parts[2], 'base64url'));
    const o = JSON.parse(
      Buffer.concat([
        d.update(Buffer.from(parts[3], 'base64url')),
        d.final(),
      ]).toString('utf8'),
    ) as Record<string, unknown>;
    return {
      name: str(o.name),
      email: str(o.email),
      externalId: str(o.externalId),
      userHash: str(o.userHash),
    };
  } catch {
    return null;
  }
}

/** Пустой identify (все поля null) не хранится вовсе. */
export function hasIdentity(i: WidgetIdentity | null | undefined): boolean {
  return !!i && !!(i.name || i.email || i.externalId || i.userHash);
}
