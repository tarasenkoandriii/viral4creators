/**
 * Шифрование полей лида — W3 (ТЗ §6.1, К-3; контракт §1 п.12): AES-256-GCM,
 * ключ — производный HMAC(ASSIST_SECRETS_KEY, метка) (без нового секрета,
 * как ключ visitor-token и соль ipHash виджета). Формат строки:
 * `v1.<iv b64url>.<tag b64url>.<шифр b64url>`; связка с id лида (AAD) —
 * шифр одного лида нельзя подложить в другой.
 * Без ключа лид не принимается (а не пишется открытым текстом).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';

/** Метка производного ключа (не бренд: в DNS/HTML её никто не видит). */
const LEAD_KEY_LABEL = 'assist-site-lead-fields-v1';

export type LeadFields = Partial<
  Record<'name' | 'phone' | 'email' | 'comment', string>
>;

export function leadKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const secret = env.ASSIST_SECRETS_KEY?.trim();
  if (!secret) return null;
  return createHmac('sha256', secret).update(LEAD_KEY_LABEL).digest();
}

export function encryptLeadFields(
  fields: LeadFields,
  leadId: string,
  key: Buffer,
): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(leadId, 'utf8'));
  const enc = Buffer.concat([
    c.update(JSON.stringify(fields), 'utf8'),
    c.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    c.getAuthTag().toString('base64url'),
    enc.toString('base64url'),
  ].join('.');
}

/** null — чужой ключ, порча или чужой лид (без исключения и без текста в лог). */
export function decryptLeadFields(
  blob: string,
  leadId: string,
  key: Buffer,
): LeadFields | null {
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const d = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parts[1], 'base64url'),
    );
    d.setAAD(Buffer.from(leadId, 'utf8'));
    d.setAuthTag(Buffer.from(parts[2], 'base64url'));
    const out = Buffer.concat([
      d.update(Buffer.from(parts[3], 'base64url')),
      d.final(),
    ]).toString('utf8');
    const o = JSON.parse(out) as Record<string, unknown>;
    const res: LeadFields = {};
    for (const k of ['name', 'phone', 'email', 'comment'] as const) {
      if (typeof o[k] === 'string') res[k] = o[k] as string;
    }
    return res;
  } catch {
    return null;
  }
}
