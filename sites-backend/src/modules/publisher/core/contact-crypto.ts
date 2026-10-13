/**
 * AI Publisher — шифр контактов, заметок и пути копии; HMAC совпадения
 * контактов и ключа IP (P-A1, проектный документ §1 п.7, §6.5, §15.4;
 * Р-PUB-15; образец — `assist-site-chat/lead-crypto.ts`).
 *
 * Ключи — производные связки `ASSIST_SECRETS_KEY` (`common/secrets-keyring`)
 * с метками `PUBLISHER_SECRET_LABELS` (`brand.ts`): новый секрет не нужен,
 * ротация — общим `npm run secrets:rotate` (`common/secrets-rotation.ts`).
 *
 * Шифротекст: `<версия ключа>.<iv b64url>.<tag b64url>.<шифр b64url>`,
 * AES-256-GCM, AAD — id строки (контакт — `leadId`, заметка — id решения
 * или проспекта, путь копии — id копии): шифр одной строки нельзя подложить
 * в другую. Версия ключа (`v1`, `v2`, …) — ПРЕФИКС строки (у Publisher нет
 * данных «до №60»), поэтому расшифровка берёт ровно ключ этой версии, а
 * перешифровка видит устаревшие строки без попыток; формат проходит
 * триггеры (`^v[0-9]+\.…`).
 *
 * `matchHash` = HMAC-SHA256(ключ `publisher-contact-match-v1`,
 * `productId \n метод \n нормализованный контакт`): без межпродуктовой
 * сопоставимости (аудит P3-19). При ротации сравнение — по всем ключам
 * (`contactMatchHashes`), пересчёт — `secrets:rotate`.
 *
 * Без ключа — `null`: вызывающий отвечает `PUB_CONTACT_KEY_MISSING` (503),
 * а не пишет открытым текстом. Ошибки расшифровки — `null` без текста в лог.
 *
 * Чистый модуль (его берёт публичный код приёма заявок).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';
import { PUBLISHER_SECRET_LABELS } from '../../../brand';
import {
  derivedKeys,
  hmacKeyList,
  type DerivedKeys,
} from '../../../common/secrets-keyring';
import type { ContactMethod } from '../contracts/states';

export type PublisherSecretPurpose = keyof typeof PUBLISHER_SECRET_LABELS;

/** Производные ключи назначения всех версий; null — нет `ASSIST_SECRETS_KEY`. */
export function publisherKeys(
  purpose: PublisherSecretPurpose,
  env: NodeJS.ProcessEnv = process.env,
): DerivedKeys | null {
  return derivedKeys(env, PUBLISHER_SECRET_LABELS[purpose]);
}

const VERSION_RE = /^v[1-9]\d{0,3}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface Sealed {
  enc: string;
  keyVersion: string;
}

/** Зашифровать строку текущим ключом; AAD — id строки. */
export function sealText(
  plain: string,
  aad: string,
  keys: DerivedKeys,
): Sealed {
  if (!aad) throw new Error('sealText: пустой AAD');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keys.currentKey, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return {
    enc: [
      keys.current,
      iv.toString('base64url'),
      c.getAuthTag().toString('base64url'),
      enc.toString('base64url'),
    ].join('.'),
    keyVersion: keys.current,
  };
}

/** Версия ключа шифротекста (префикс) или null — не наш формат. */
export function sealedVersion(enc: unknown): string | null {
  if (typeof enc !== 'string') return null;
  const parts = enc.split('.');
  if (parts.length !== 4 || !VERSION_RE.test(parts[0])) return null;
  return parts.slice(1).every((p) => B64URL.test(p)) ? parts[0] : null;
}

/** Расшифровать ключом версии из префикса; null — чужой ключ, порча, чужая строка. */
export function openText(
  enc: unknown,
  aad: string,
  keys: DerivedKeys,
): { value: string; version: string } | null {
  const version = sealedVersion(enc);
  if (!version) return null;
  const key = keys.key(version);
  if (!key) return null;
  const [, iv, tag, body] = (enc as string).split('.');
  try {
    const d = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64url'),
    );
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    const out = Buffer.concat([
      d.update(Buffer.from(body, 'base64url')),
      d.final(),
    ]);
    return { value: out.toString('utf8'), version };
  } catch {
    return null;
  }
}

/**
 * Перешифровать текущим ключом (ротация). `null` — не открылся ни одним
 * ключом; `same: true` — уже текущей версией, переписывать не нужно.
 */
export function resealText(
  enc: string,
  aad: string,
  keys: DerivedKeys,
): { enc: string; keyVersion: string; same: boolean; from: string } | null {
  const opened = openText(enc, aad, keys);
  if (!opened) return null;
  if (opened.version === keys.current) {
    return {
      enc,
      keyVersion: opened.version,
      same: true,
      from: opened.version,
    };
  }
  const next = sealText(opened.value, aad, keys);
  return { ...next, same: false, from: opened.version };
}

// ── Контакт заявителя (`pub_lead_contacts.contactEnc`, AAD = leadId) ──────

/** Всё, что ТЗ относит к защищённому контуру заявки (§1 п.7, §6.5). */
export interface ContactPayload {
  name: string;
  contactMethod: ContactMethod;
  contact: string;
  business: string | null;
  task: string;
  /** Свободный самоотчёт «где узнали» (категория — открыто в pub_leads). */
  selfReported: string | null;
}

export function sealContact(
  payload: ContactPayload,
  leadId: string,
  keys: DerivedKeys,
): Sealed {
  return sealText(JSON.stringify(payload), leadId, keys);
}

export function openContact(
  enc: unknown,
  leadId: string,
  keys: DerivedKeys,
): { value: ContactPayload; version: string } | null {
  const opened = openText(enc, leadId, keys);
  if (!opened) return null;
  try {
    const o = JSON.parse(opened.value) as Record<string, unknown>;
    const str = (k: string) =>
      typeof o[k] === 'string' ? (o[k] as string) : null;
    const name = str('name');
    const contact = str('contact');
    const method = str('contactMethod');
    const task = str('task');
    if (name === null || contact === null || method === null || task === null) {
      return null;
    }
    return {
      value: {
        name,
        contactMethod: method as ContactMethod,
        contact,
        business: str('business'),
        task,
        selfReported: str('selfReported'),
      },
      version: opened.version,
    };
  } catch {
    return null;
  }
}

// ── Заметки (`noteEnc`, AAD = id строки) и путь копии (AAD = id копии) ───

export const sealNote = (
  text: string,
  rowId: string,
  keys: DerivedKeys,
): Sealed => sealText(text, rowId, keys);
export const openNote = (enc: unknown, rowId: string, keys: DerivedKeys) =>
  openText(enc, rowId, keys);
export const sealBackupPath = (
  path: string,
  backupId: string,
  keys: DerivedKeys,
): Sealed => sealText(path, backupId, keys);
export const openBackupPath = (
  enc: unknown,
  backupId: string,
  keys: DerivedKeys,
) => openText(enc, backupId, keys);

// ── Совпадение контактов (`matchHash`) ────────────────────────────────────

/**
 * Нормализация контакта для точного совпадения (Р-PUB-15): email — нижний
 * регистр без пробелов; телефон — только цифры (ведущий `+` и международный
 * префикс `00` отбрасываются; рынок пилота — Украина: `0XXXXXXXXX` →
 * `380XXXXXXXXX`, старый междугородний `80XXXXXXXXX` → `380XXXXXXXXX`,
 * аудит P3-9); telegram — без `@` и `t.me/` / `telegram.me/` (со схемой и
 * `www.` или без), нижний регистр; прочее — обрезка и нижний регистр.
 */
export function normalizeContact(method: ContactMethod, raw: string): string {
  const v = raw.normalize('NFKC').trim();
  switch (method) {
    case 'email':
      return v.toLowerCase().replace(/\s+/g, '');
    case 'phone': {
      const digits = v.replace(/\D+/g, '').replace(/^00/, '');
      if (/^0\d{9}$/.test(digits)) return `38${digits}`;
      if (/^80\d{9}$/.test(digits)) return `3${digits}`;
      return digits;
    }
    case 'telegram':
      return v
        .toLowerCase()
        .replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//, '')
        .replace(/^@/, '')
        .replace(/\s+/g, '');
    default:
      return v.toLowerCase().replace(/\s+/g, ' ');
  }
}

function matchMessage(
  productId: string,
  method: ContactMethod,
  contact: string,
): string {
  return `${productId}\n${method}\n${normalizeContact(method, contact)}`;
}

/** matchHash текущим ключом (64 hex). */
export function contactMatchHash(
  productId: string,
  method: ContactMethod,
  contact: string,
  keys: DerivedKeys,
): string {
  return createHmac('sha256', keys.currentKey)
    .update(matchMessage(productId, method, contact), 'utf8')
    .digest('hex');
}

/** matchHash всеми ключами связки (поиск совпадений во время ротации). */
export function contactMatchHashes(
  productId: string,
  method: ContactMethod,
  contact: string,
  keys: DerivedKeys,
): string[] {
  const msg = matchMessage(productId, method, contact);
  return hmacKeyList(keys.all).map((k) =>
    createHmac('sha256', k).update(msg, 'utf8').digest('hex'),
  );
}

/**
 * HMAC ключа IP окна лимита формы (`pub_rate_hits.key`, §6.2): от
 * `ipLimitKey(ip)` (`common/ip-limit-key.ts`), без суточной соли; сырой IP
 * не хранится.
 */
export function rateIpHmac(ipLimitKeyValue: string, keys: DerivedKeys): string {
  return createHmac('sha256', keys.currentKey)
    .update(ipLimitKeyValue, 'utf8')
    .digest('hex');
}

/**
 * Рекомендация для P-D (аудит P3-10): `pub_leads.requestHash` — защита от
 * повторной отправки формы — НЕ беcключевой sha256 тела: тело содержит
 * контакт и имя, а роль `publisher_public` может читать колонку, и по
 * дампу перебор телефонов дал бы контакт. Hash — ключевой HMAC связки
 * `contactMatch` с отдельной меткой домена и `productId`; во время
 * ротации повтор ищется по всем ключам (`leadRequestHmacs`).
 * `canonicalBody` — `canonicalJson` нормализованного тела заявки.
 */
export function leadRequestHmac(
  productId: string,
  canonicalBody: string,
  keys: DerivedKeys,
): string {
  return createHmac('sha256', keys.currentKey)
    .update(`lead-request\n${productId}\n${canonicalBody}`, 'utf8')
    .digest('hex');
}

export function leadRequestHmacs(
  productId: string,
  canonicalBody: string,
  keys: DerivedKeys,
): string[] {
  const msg = `lead-request\n${productId}\n${canonicalBody}`;
  return hmacKeyList(keys.all).map((k) =>
    createHmac('sha256', k).update(msg, 'utf8').digest('hex'),
  );
}
