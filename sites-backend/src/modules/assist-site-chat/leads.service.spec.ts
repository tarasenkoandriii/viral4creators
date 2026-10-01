import { defaultLeadsConfig } from '../assist-site-setup/leads-config';
import { decryptLeadFields, encryptLeadFields, leadKey } from './lead-crypto';
import {
  consentTextFor,
  leadPageUrl,
  validateLeadFields,
} from './leads.service';

describe('шифр полей лида (AES-256-GCM, ключ из ASSIST_SECRETS_KEY)', () => {
  const key = leadKey({ ASSIST_SECRETS_KEY: 'k1' })!;
  it('туда-обратно; чужой ключ, чужой id, порча — null', () => {
    const enc = encryptLeadFields(
      { name: 'Олена', phone: '+380' },
      'lead-1',
      key,
    );
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain('Олена');
    expect(decryptLeadFields(enc, 'lead-1', key)).toEqual({
      name: 'Олена',
      phone: '+380',
    });
    expect(decryptLeadFields(enc, 'lead-2', key)).toBeNull();
    expect(
      decryptLeadFields(enc, 'lead-1', leadKey({ ASSIST_SECRETS_KEY: 'k2' })!),
    ).toBeNull();
    expect(
      decryptLeadFields(enc.slice(0, -2) + 'AA', 'lead-1', key),
    ).toBeNull();
    expect(leadKey({})).toBeNull();
  });
});

describe('проверка формы лида', () => {
  const cfg = {
    ...defaultLeadsConfig(),
    fields: [
      { field: 'name' as const, required: true },
      { field: 'phone' as const, required: false },
      { field: 'email' as const, required: false },
    ],
  };
  it('обязательные, формат, лишнее, контакт; управляющие символы срезаются', () => {
    expect(
      validateLeadFields(cfg, { name: ' Оля​ ', phone: '+38 (067) 123-45-67' }),
    ).toEqual({
      ok: true,
      fields: { name: 'Оля', phone: '+38 (067) 123-45-67' },
    });
    expect(validateLeadFields(cfg, { phone: '+380671234567' })).toMatchObject({
      ok: false,
      errors: [{ field: 'name', code: 'required' }],
    });
    expect(
      validateLeadFields(cfg, { name: 'О', email: 'not-mail' }),
    ).toMatchObject({ ok: false });
    expect(
      validateLeadFields(cfg, {
        name: 'О',
        comment: 'x',
        phone: '+380671234567',
      }),
    ).toMatchObject({
      ok: false,
      errors: [{ field: 'comment', code: 'unknown' }],
    });
    expect(validateLeadFields(cfg, { name: 'О' })).toMatchObject({
      ok: false,
      errors: [{ field: 'phone|email', code: 'contact_required' }],
    });
  });
  it('согласие — на языке интерфейса, иначе первое заданное; страница — без query', () => {
    expect(consentTextFor({ ...cfg, consentText: { ru: 'RU' } }, 'en')).toBe(
      'RU',
    );
    expect(consentTextFor({ ...cfg, consentText: {} }, 'uk')).toBeNull();
    expect(leadPageUrl('https://a.example/x?phone=1#y')).toBe(
      'https://a.example/x',
    );
    expect(leadPageUrl('javascript:alert(1)')).toBeNull();
  });
});
