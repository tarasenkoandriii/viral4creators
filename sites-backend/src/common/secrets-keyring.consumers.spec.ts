/**
 * №60 (Р-З10-12): ни один шифротекст и токен, записанный ДО связки ключей,
 * не становится нечитаемым — ни сразу после выката, ни после ротации
 * (`ASSIST_SECRETS_KEY_VERSION=v2`, прежний — в `ASSIST_SECRETS_KEYS_OLD`).
 *
 * Строки `LEGACY_*` записаны ЗАМОРОЖЕННОЙ копией кода до №60 (lead-crypto,
 * handoff identity-crypto, token-crypto + billing-env) ключом `K1` — это
 * байты, которые уже лежат в базах, а не то, что умеет новый код.
 * Обратная сторона (откат выката): пока версия v1, новый код пишет ровно
 * прежний формат — его открывает замороженный decrypt.
 */
import { createDecipheriv, createHmac } from 'crypto';
import {
  WIDGET_TOKEN_HMAC_LABEL,
  WIDGET_VIDEO_LINK_HMAC_LABEL,
} from '../brand';
import { videoLinkKey, videoLinkKeys } from '../config/media-env';
import { widgetTokenKey, widgetTokenKeys } from '../config/widget-env';
import {
  openPaymentToken,
  paymentTokenKey,
  sealPaymentToken,
} from '../modules/assist-billing/billing-env';
import {
  decryptLeadFields,
  encryptLeadFields,
  leadKey,
} from '../modules/assist-site-chat/lead-crypto';
import {
  decryptIdentity,
  encryptIdentity,
} from '../modules/assist-site-handoff/public/identity-crypto';
import {
  signVideoLink,
  verifyVideoLink,
} from '../modules/assist-site-media/public/video-link';
import {
  inspectVisitorToken,
  signVisitorToken,
} from '../modules/assist-widget/visitor-token';
import { WidgetSessionService } from '../modules/assist-widget/widget-session.service';
import { widgetEnvProblems, widgetOrigin } from '../config/widget-env';
import { decryptToken, encryptToken } from '../shared/token-crypto';
import { voiceTicketKey, voiceTicketKeys } from '../config/voice-env';
import {
  issueVoiceTicket,
  verifyVoiceTicket,
} from '../modules/assist-site-voice/public/voice-ticket';
import {
  issueAdminVoiceTicket,
  verifyAdminVoiceTicket,
} from '../modules/assist-admin-voice/admin-stt';
import {
  signMemoPage,
  verifyMemoPage,
} from '../modules/assist-site-voice-control/public/memo-check';
import { WIDGET_VOICE_TICKET_HMAC_LABEL } from '../brand';

const K1 = 'legacy-secret-k1';
const K2 = 'rotated-secret-k2';
const LEGACY_LEAD =
  'v1.Hn8_zXBfQLeUfI5x.u3jESKR7L0Bk5r9VyUseDQ.CdWX7jczuDn3xxEnK3N9OEQc-4804jEcoDoBXZYQr-gI0prupBKuW9HYIpXa';
const LEGACY_IDENTITY =
  'v1.nJx5O_cA9hce6hYC.5q-1UpStcw0iKgxuXpvkEA.IHo9WYg2C_c9AuTyD4bm_r0rsFx85qSxxQ-BfFIfwq-0DtXgRNp-8L_xRvLWSiVB6NBK3SwY5R-5REu_TTsmoRt7-yaTlKI16uo';
const LEGACY_REC_TOKEN =
  'sS5EGeCvuSGjAhfE.a7pBIhyq5mxKrYnUgHHFVg==.03XHFSoERZRoRP163IE/Jw==';

/** env до №60 / после выката без ротации. */
const BEFORE = { ASSIST_SECRETS_KEY: K1 };
/** После ротации: новый ключ v2, прежний — только чтение. */
const ROTATED = {
  ASSIST_SECRETS_KEY: K2,
  ASSIST_SECRETS_KEY_VERSION: 'v2',
  ASSIST_SECRETS_KEYS_OLD: `v1:${K1}`,
};
/** Прежний ключ уже убран из env. */
const ONLY_K2 = { ASSIST_SECRETS_KEY: K2, ASSIST_SECRETS_KEY_VERSION: 'v2' };

/** Замороженный decrypt лида до №60. */
function legacyDecryptLead(blob: string, leadId: string, secret: string) {
  const key = createHmac('sha256', secret)
    .update('assist-site-lead-fields-v1')
    .digest();
  const p = blob.split('.');
  if (p.length !== 4 || p[0] !== 'v1') return null;
  try {
    const d = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(p[1], 'base64url'),
    );
    d.setAAD(Buffer.from(leadId, 'utf8'));
    d.setAuthTag(Buffer.from(p[2], 'base64url'));
    return JSON.parse(
      Buffer.concat([
        d.update(Buffer.from(p[3], 'base64url')),
        d.final(),
      ]).toString('utf8'),
    ) as unknown;
  } catch {
    return null;
  }
}

describe('поля лида (assist_site_leads.fieldsEnc)', () => {
  const fields = { name: 'Олена', phone: '+380501234567' };

  it('строка до №60 читается после выката и после ротации', () => {
    expect(
      decryptLeadFields(LEGACY_LEAD, 'lead-legacy-1', leadKey(BEFORE)!),
    ).toEqual(fields);
    expect(
      decryptLeadFields(LEGACY_LEAD, 'lead-legacy-1', leadKey(ROTATED)!),
    ).toEqual(fields);
  });

  it('без прежнего ключа или с чужим id — null (без исключения)', () => {
    expect(
      decryptLeadFields(LEGACY_LEAD, 'lead-legacy-1', leadKey(ONLY_K2)!),
    ).toBeNull();
    expect(
      decryptLeadFields(LEGACY_LEAD, 'lead-other', leadKey(ROTATED)!),
    ).toBeNull();
  });

  it('при версии v1 пишется прежний формат — его читает код до №60 (откат)', () => {
    const enc = encryptLeadFields(fields, 'lead-2', leadKey(BEFORE)!);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(legacyDecryptLead(enc, 'lead-2', K1)).toEqual(fields);
  });

  it('после ротации пишется ключом v2 в прежнем формате: читает связка и код до №60 с тем же env (откат при VERSION≠v1)', () => {
    const enc = encryptLeadFields(fields, 'lead-3', leadKey(ROTATED)!);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(decryptLeadFields(enc, 'lead-3', leadKey(ROTATED)!)).toEqual(fields);
    expect(decryptLeadFields(enc, 'lead-3', leadKey(ONLY_K2)!)).toEqual(fields);
    expect(decryptLeadFields(enc, 'lead-3', leadKey(BEFORE)!)).toBeNull();
    // Откат выката: код до №60 знает только ASSIST_SECRETS_KEY (= K2).
    expect(legacyDecryptLead(enc, 'lead-3', K2)).toEqual(fields);
  });

  it('строка, записанная до №60 при уже заданной VERSION=v2 (без префикса, ключом v2), читается', () => {
    const preNo60 = encryptLeadFields(
      fields,
      'lead-4',
      leadKey({ ASSIST_SECRETS_KEY: K2 })!,
    );
    const v3 = {
      ASSIST_SECRETS_KEY: 'k3',
      ASSIST_SECRETS_KEY_VERSION: 'v3',
      ASSIST_SECRETS_KEYS_OLD: `v2:${K2},v1:${K1}`,
    };
    expect(decryptLeadFields(preNo60, 'lead-4', leadKey(v3)!)).toEqual(fields);
  });
});

describe('identify передачи (assist_site_handoffs.identityEnc)', () => {
  const identity = {
    name: 'Ivan',
    email: 'i@example.com',
    externalId: 'u-1',
    userHash: null,
  };

  it('строка до №60 читается до и после ротации; чужая передача — null', () => {
    expect(
      decryptIdentity(LEGACY_IDENTITY, 'handoff-legacy-1', leadKey(BEFORE)!),
    ).toEqual(identity);
    expect(
      decryptIdentity(LEGACY_IDENTITY, 'handoff-legacy-1', leadKey(ROTATED)!),
    ).toEqual(identity);
    expect(
      decryptIdentity(LEGACY_IDENTITY, 'handoff-x', leadKey(ROTATED)!),
    ).toBeNull();
    expect(
      decryptIdentity(LEGACY_IDENTITY, 'handoff-legacy-1', leadKey(ONLY_K2)!),
    ).toBeNull();
  });

  it('новая запись — прежний формат и при v1, и при v2', () => {
    expect(
      encryptIdentity(identity, 'h1', leadKey(BEFORE)!).startsWith('v1.'),
    ).toBe(true);
    const enc = encryptIdentity(identity, 'h1', leadKey(ROTATED)!);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(decryptIdentity(enc, 'h1', leadKey(BEFORE)!)).toBeNull();
    expect(decryptIdentity(enc, 'h1', leadKey(ONLY_K2)!)).toEqual(identity);
  });
});

describe('recToken (assist_subscriptions.recTokenEnc)', () => {
  it('строка до №60 открывается до и после ротации', () => {
    expect(openPaymentToken(LEGACY_REC_TOKEN, BEFORE)).toEqual({
      value: 'rec-token-legacy',
      version: 'v1',
    });
    expect(openPaymentToken(LEGACY_REC_TOKEN, ROTATED)?.value).toBe(
      'rec-token-legacy',
    );
    expect(openPaymentToken(LEGACY_REC_TOKEN, ONLY_K2)).toBeNull();
    expect(openPaymentToken('мусор', ROTATED)).toBeNull();
    expect(openPaymentToken(null, ROTATED)).toBeNull();
  });

  it('при v1 пишется прежний формат token-crypto ключом paymentTokenKey (откат)', () => {
    const enc = sealPaymentToken('rt-1', BEFORE)!;
    expect(enc.split('.')).toHaveLength(3);
    expect(decryptToken(enc, paymentTokenKey(BEFORE)!)).toBe('rt-1');
    // Строка, записанная напрямую encryptToken (как в приёмке e4), читается.
    expect(
      openPaymentToken(encryptToken('rt-2', paymentTokenKey(BEFORE)!), ROTATED)
        ?.value,
    ).toBe('rt-2');
  });

  it('после ротации — ключом v2 в прежнем формате (откат читает); без ключа — null', () => {
    const enc = sealPaymentToken('rt-3', ROTATED)!;
    expect(enc.split('.')).toHaveLength(3);
    expect(decryptToken(enc, paymentTokenKey(ROTATED)!)).toBe('rt-3');
    expect(openPaymentToken(enc, ONLY_K2)).toEqual({
      value: 'rt-3',
      version: 'v2',
    });
    expect(openPaymentToken(enc, BEFORE)).toBeNull();
    expect(sealPaymentToken('x', {})).toBeNull();
  });
});

describe('HMAC-токены: подпись текущим, проверка текущим и прежними', () => {
  const NOW = new Date('2026-10-08T12:00:00Z');
  const iat = Math.floor(NOW.getTime() / 1000);
  const payload = {
    v: 1 as const,
    siteId: 'site1',
    visitorId: 'v_abc',
    parentOrigin: 'https://shop.example.com',
    ipHash: 'a'.repeat(64),
    preview: false,
    iat,
    exp: iat + 3600,
  };
  /** Ключ visitor-token до №60 — замороженная формула. */
  const legacyTokenKey = createHmac('sha256', K1)
    .update(WIDGET_TOKEN_HMAC_LABEL)
    .digest();

  it('visitor-token, выданный до ротации, принимается после неё', () => {
    expect(widgetTokenKey(BEFORE)!.equals(legacyTokenKey)).toBe(true);
    const old = signVisitorToken(payload, legacyTokenKey);
    expect(
      inspectVisitorToken(old, widgetTokenKeys(ROTATED)!, NOW).status,
    ).toBe('ok');
    expect(
      inspectVisitorToken(old, widgetTokenKeys(ONLY_K2)!, NOW).status,
    ).toBe('invalid');
    // Новый подписан текущим (v2) — прежний ключ его не принимает.
    const fresh = signVisitorToken(payload, widgetTokenKey(ROTATED)!);
    expect(
      inspectVisitorToken(fresh, widgetTokenKeys(ROTATED)!, NOW).status,
    ).toBe('ok');
    expect(inspectVisitorToken(fresh, legacyTokenKey, NOW).status).toBe(
      'invalid',
    );
  });

  it('ссылка на ролик, выданная до ротации, проверяется после неё', () => {
    const legacyLinkKey = createHmac('sha256', K1)
      .update(WIDGET_VIDEO_LINK_HMAC_LABEL)
      .digest();
    expect(videoLinkKey(BEFORE)!.equals(legacyLinkKey)).toBe(true);
    const link = signVideoLink(legacyLinkKey, {
      siteId: 's1',
      videoId: 'vid1',
      expUnix: iat + 300,
    });
    expect(verifyVideoLink(videoLinkKeys(ROTATED)!, link, iat).ok).toBe(true);
    expect(verifyVideoLink(videoLinkKeys(ONLY_K2)!, link, iat)).toEqual({
      ok: false,
      reason: 'signature',
    });
    expect(videoLinkKey(ROTATED)!.equals(videoLinkKeys(ROTATED)![0])).toBe(
      true,
    );
  });
});

describe('сессия виджета берёт всю связку (WidgetSessionService.authenticate)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('visitor-token, подписанный прежним ключом, проходит после ротации', async () => {
    process.env = { ...saved, ...ROTATED };
    delete process.env.ASSIST_WIDGET_ORIGIN;
    const now = new Date('2026-10-08T12:00:00Z');
    const iat = Math.floor(now.getTime() / 1000);
    const legacyKey = createHmac('sha256', K1)
      .update(WIDGET_TOKEN_HMAC_LABEL)
      .digest();
    const token = signVisitorToken(
      {
        v: 1,
        siteId: 'site1',
        visitorId: 'v1',
        parentOrigin: 'https://shop.example.com',
        ipHash: 'a'.repeat(64),
        preview: false,
        iat,
        exp: iat + 3600,
      },
      legacyKey,
    );
    const svc = Object.create(WidgetSessionService.prototype) as {
      guard: unknown;
      db: unknown;
      authenticate: WidgetSessionService['authenticate'];
    };
    svc.guard = {
      recheck: () =>
        Promise.resolve({ decision: { ok: true, site: { siteId: 'site1' } } }),
    };
    svc.db = { assistSiteMessage: { count: () => Promise.resolve(0) } };
    const ctx = await svc.authenticate({
      token,
      requestOrigin: widgetOrigin(),
      now,
    });
    expect(ctx.visitor.visitorId).toBe('v1');
    process.env = { ...saved, ...ONLY_K2 };
    await expect(
      svc.authenticate({ token, requestOrigin: widgetOrigin(), now }),
    ).rejects.toBeTruthy();
  });

  it('ошибки связки видны в проверке env виджета — без значений ключей', () => {
    const problems = widgetEnvProblems({
      ASSIST_WIDGET_ORIGIN: 'https://w.example.com',
      ASSIST_SECRETS_KEY: K2,
      ASSIST_SECRETS_KEYS_OLD: `v1${K1}`,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/ASSIST_SECRETS_KEYS_OLD/);
    expect(problems[0]).not.toContain(K1);
  });
});

describe('билеты голоса и итоги мемо (P3-2): подпись текущим, проверка связкой', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const legacy = createHmac('sha256', K1)
    .update(WIDGET_VOICE_TICKET_HMAC_LABEL)
    .digest();

  it('ключ подписи v1 — прежняя формула; после ротации — текущий', () => {
    expect(voiceTicketKey(BEFORE)!.equals(legacy)).toBe(true);
    expect(voiceTicketKey(ROTATED)!.equals(voiceTicketKeys(ROTATED)![0])).toBe(
      true,
    );
  });

  it('билет виджета, выданный до ротации, принимается после неё', () => {
    const p = { siteId: 's1', visitorId: 'v1', text: 'купити', now };
    const t = issueVoiceTicket(legacy, { ...p, ttlMs: 600_000 });
    expect(verifyVoiceTicket(voiceTicketKeys(ROTATED), t, p)).toBe(true);
    expect(verifyVoiceTicket(voiceTicketKeys(ONLY_K2), t, p)).toBe(false);
    expect(verifyVoiceTicket(voiceTicketKeys({}), t, p)).toBe(false);
  });

  it('билет «Админки», выданный до ротации, принимается после неё', () => {
    const p = { siteId: 's1', actor: 'e1', text: 'звіт', now };
    const t = issueAdminVoiceTicket(legacy, p);
    expect(verifyAdminVoiceTicket(voiceTicketKeys(ROTATED), t, p)).toBe(true);
    expect(verifyAdminVoiceTicket(voiceTicketKeys(ONLY_K2), t, p)).toBe(false);
  });

  it('итог страницы мемо, подписанный до ротации, принимается после неё', () => {
    const page = { path: '/cart', steps: [], goal: 'ok' as const };
    const t = signMemoPage(legacy, 'test1', page);
    expect(verifyMemoPage(voiceTicketKeys(ROTATED), 'test1', t)).toEqual(page);
    expect(verifyMemoPage(voiceTicketKeys(ONLY_K2), 'test1', t)).toBeNull();
    expect(verifyMemoPage(voiceTicketKeys(ROTATED), 'test2', t)).toBeNull();
  });
});
