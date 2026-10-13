/**
 * Шифр контактов и заметок, HMAC совпадения (P-A1, проектный документ §1
 * п.7, §6.5; Р-PUB-15; аудит P3-19): AAD = id строки, `productId` в HMAC,
 * ротация ключа (версия — префикс шифротекста), формат проходит триггер.
 */
import { createHmac } from 'crypto';
import { PUBLISHER_SECRET_LABELS } from '../../../brand';
import {
  contactMatchHash,
  contactMatchHashes,
  leadRequestHmac,
  leadRequestHmacs,
  normalizeContact,
  openBackupPath,
  openContact,
  openNote,
  openText,
  publisherKeys,
  rateIpHmac,
  resealText,
  sealBackupPath,
  sealContact,
  sealNote,
  sealedVersion,
  type ContactPayload,
} from './contact-crypto';
import { sha256Hex } from './content-hash';

const V1 = { ASSIST_SECRETS_KEY: 'test-key-one' };
const V2 = {
  ASSIST_SECRETS_KEY: 'test-key-two',
  ASSIST_SECRETS_KEY_VERSION: 'v2',
  ASSIST_SECRETS_KEYS_OLD: 'v1:test-key-one',
};
const PAYLOAD: ContactPayload = {
  name: 'Тестовий Заявник',
  contactMethod: 'email',
  contact: 'Lead@Example.UA',
  business: 'Школа англійської',
  task: 'Потрібні статті',
  selfReported: null,
};
/** Формат триггера `pub_lead_contacts_guard`. */
const TRIGGER_RE =
  /^v[0-9]+\.[A-Za-z0-9_=+/-]+\.[A-Za-z0-9_=+/-]+\.[A-Za-z0-9_=+/-]+$/;

describe('contact-crypto', () => {
  const k1 = publisherKeys('leadContact', V1)!;
  const k2 = publisherKeys('leadContact', V2)!;

  it('без ASSIST_SECRETS_KEY — ключей нет (вызывающий отвечает 503, не пишет открыто)', () => {
    expect(publisherKeys('leadContact', {})).toBeNull();
  });

  it('контакт: шифр формата триггера, расшифровка своим leadId; чужой AAD/порча — null', () => {
    const sealed = sealContact(PAYLOAD, 'lead-1', k1);
    expect(sealed.enc).toMatch(TRIGGER_RE);
    expect(sealed.keyVersion).toBe('v1');
    expect(sealed.enc.startsWith('v1.')).toBe(true);
    expect(sealed.enc).not.toContain('Example');
    expect(openContact(sealed.enc, 'lead-1', k1)).toEqual({
      value: PAYLOAD,
      version: 'v1',
    });
    expect(openContact(sealed.enc, 'lead-2', k1)).toBeNull();
    const broken =
      sealed.enc.slice(0, -2) + (sealed.enc.endsWith('A') ? 'BB' : 'AA');
    expect(openContact(broken, 'lead-1', k1)).toBeNull();
    expect(openContact('plain text', 'lead-1', k1)).toBeNull();
  });

  it('метки разные: шифр контакта не открывается ключом заметок', () => {
    const notes = publisherKeys('leadNotes', V1)!;
    const sealed = sealContact(PAYLOAD, 'lead-1', k1);
    expect(openText(sealed.enc, 'lead-1', notes)).toBeNull();
    expect(new Set(Object.values(PUBLISHER_SECRET_LABELS)).size).toBe(5);
  });

  it('ротация: v1 читается связкой v2 (прежний ключ), перешифровка — в v2; без прежнего ключа v1 не открыть', () => {
    const old = sealNote(
      'Перезвонить у вівторок',
      'dec-1',
      publisherKeys('leadNotes', V1)!,
    );
    const notes2 = publisherKeys('leadNotes', V2)!;
    expect(openNote(old.enc, 'dec-1', notes2)).toEqual({
      value: 'Перезвонить у вівторок',
      version: 'v1',
    });
    const re = resealText(old.enc, 'dec-1', notes2)!;
    expect(re).toMatchObject({ same: false, from: 'v1', keyVersion: 'v2' });
    expect(sealedVersion(re.enc)).toBe('v2');
    expect(
      openNote(
        re.enc,
        'dec-1',
        publisherKeys('leadNotes', {
          ASSIST_SECRETS_KEY: 'test-key-two',
          ASSIST_SECRETS_KEY_VERSION: 'v2',
        })!,
      ),
    ).toEqual({
      value: 'Перезвонить у вівторок',
      version: 'v2',
    });
    expect(resealText(re.enc, 'dec-1', notes2)!.same).toBe(true);
    expect(
      openNote(
        old.enc,
        'dec-1',
        publisherKeys('leadNotes', {
          ASSIST_SECRETS_KEY: 'test-key-two',
          ASSIST_SECRETS_KEY_VERSION: 'v2',
        })!,
      ),
    ).toBeNull();
    expect(
      openContact(sealContact(PAYLOAD, 'l', k1).enc, 'l', k2)?.version,
    ).toBe('v1');
  });

  it('путь копии — AAD = id копии', () => {
    const k = publisherKeys('backup', V1)!;
    const p = sealBackupPath('publisher/abc.json.gz.enc', 'bk-1', k);
    expect(openBackupPath(p.enc, 'bk-1', k)?.value).toBe(
      'publisher/abc.json.gz.enc',
    );
    expect(openBackupPath(p.enc, 'bk-2', k)).toBeNull();
  });

  it('matchHash: нормализация, productId в HMAC (нет межпродуктовой сопоставимости), все ключи связки', () => {
    const m1 = publisherKeys('contactMatch', V1)!;
    const a = contactMatchHash('p1', 'email', ' Lead@Example.UA ', m1);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(contactMatchHash('p1', 'email', 'lead@example.ua', m1)).toBe(a);
    expect(contactMatchHash('p2', 'email', 'lead@example.ua', m1)).not.toBe(a);
    expect(contactMatchHash('p1', 'phone', 'lead@example.ua', m1)).not.toBe(a);
    const expected = createHmac('sha256', m1.currentKey)
      .update('p1\nemail\nlead@example.ua')
      .digest('hex');
    expect(a).toBe(expected);
    const m2 = publisherKeys('contactMatch', V2)!;
    expect(contactMatchHashes('p1', 'email', 'lead@example.ua', m2)).toEqual([
      contactMatchHash('p1', 'email', 'lead@example.ua', m2),
      a,
    ]);
  });

  it('нормализация контакта по способу связи', () => {
    expect(normalizeContact('phone', '+38 (067) 123-45-67')).toBe(
      '380671234567',
    );
    expect(normalizeContact('phone', '067 123 45 67')).toBe('380671234567');
    expect(normalizeContact('telegram', 'https://t.me/Some_User')).toBe(
      'some_user',
    );
    expect(normalizeContact('telegram', '@Some_User')).toBe('some_user');
    expect(normalizeContact('email', ' A.B@X.UA ')).toBe('a.b@x.ua');
    expect(normalizeContact('other', '  Viber   Ivan ')).toBe('viber ivan');
    // аудит P3-9: 80…, 00380…, t.me без схемы, telegram.me
    expect(normalizeContact('phone', '8 067 123 45 67')).toBe('380671234567');
    expect(normalizeContact('phone', '00380671234567')).toBe('380671234567');
    expect(normalizeContact('phone', '0038 067 123 45 67')).toBe(
      '380671234567',
    );
    expect(normalizeContact('telegram', 't.me/Ivan')).toBe('ivan');
    expect(normalizeContact('telegram', 'www.t.me/ivan')).toBe('ivan');
    expect(normalizeContact('telegram', 'https://telegram.me/ivan')).toBe(
      'ivan',
    );
  });

  it('аудит P3-10: requestHash заявки — ключевой HMAC (без ключа не повторить), все ключи — при ротации', () => {
    const k = publisherKeys('contactMatch', V1)!;
    const body = '{"contact":"+380671234567","name":"Іван"}';
    const h = leadRequestHmac('pp_1', body, k);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(sha256Hex(body));
    expect(leadRequestHmac('pp_2', body, k)).not.toBe(h);
    expect(leadRequestHmacs('pp_1', body, k)).toContain(h);
  });

  it('HMAC ключа IP окна формы — детерминирован и не равен входу', () => {
    const k = publisherKeys('rateIp', V1)!;
    expect(rateIpHmac('192.0.2.0/24', k)).toBe(rateIpHmac('192.0.2.0/24', k));
    expect(rateIpHmac('192.0.2.0/24', k)).not.toContain('192');
  });
});
