'use client';

import { useRef, useState, type FormEvent } from 'react';
import {
  HONEYPOT_FIELD,
  PILOT_LIMITS,
  PILOT_SEGMENTS,
  validatePilot,
  type PilotField,
  type PilotResultCode,
} from '../lib/pilot-validation';

export interface PilotFormStrings {
  heading: string;
  name: string;
  contact: string;
  contactHint: string;
  site: string;
  siteHint: string;
  segment: string;
  segments: Record<(typeof PILOT_SEGMENTS)[number], string>;
  message: string;
  consent: string;
  consentLink: string;
  honeypot: string;
  required: string;
  submit: string;
  sending: string;
  result: Record<PilotResultCode, string>;
  errors: Record<PilotField, string>;
}

/**
 * Форма заявки в пилот (§3.11). Работает и без JS: `action` ведёт на
 * тот же route handler, он отвечает 303 на страницу результата. С JS —
 * отправка `fetch` без перезагрузки, ошибки у полей, итог — в
 * `role="status"`.
 *
 * Обещание «ничего не теряется молча»: при любом исходе, кроме `sent`,
 * поля НЕ очищаются, а текст прямо говорит, что заявка не отправлена.
 * Секретов здесь нет и быть не может: только общий модуль проверки
 * полей (тот же, что на сервере).
 */
export function PilotForm({ locale, strings, privacyHref }: { locale: string; strings: PilotFormStrings; privacyHref: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PilotResultCode | null>(null);
  const [errors, setErrors] = useState<PilotField[]>([]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form)) as Record<string, unknown>;
    data.consent = (form.elements.namedItem('consent') as HTMLInputElement | null)?.checked ?? false;
    const local = validatePilot(data);
    if (!local.ok) {
      setErrors(local.errors);
      setResult('invalid');
      statusRef.current?.focus();
      return;
    }
    setBusy(true);
    setErrors([]);
    let code: PilotResultCode = 'error';
    try {
      const res = await fetch('/api/pilot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = (await res.json().catch(() => null)) as { code?: PilotResultCode; fields?: PilotField[] } | null;
      code = json?.code ?? 'error';
      if (code === 'invalid' && Array.isArray(json?.fields)) setErrors(json.fields);
    } catch {
      code = 'error';
    }
    setBusy(false);
    setResult(code);
    if (code === 'sent') form.reset();
    statusRef.current?.focus();
  }

  const invalid = (field: PilotField) => errors.includes(field);
  const describedBy = (field: PilotField, hint?: string) =>
    [hint, invalid(field) ? `pilot-${field}-error` : undefined].filter(Boolean).join(' ') || undefined;
  const fieldError = (field: PilotField) =>
    invalid(field) ? (
      <span className="field-error" id={`pilot-${field}-error`}>
        {strings.errors[field]}
      </span>
    ) : null;

  return (
    <form
      ref={formRef}
      className="pilot-form"
      action="/api/pilot"
      method="post"
      onSubmit={onSubmit}
      aria-labelledby="pilot-form-heading"
    >
      <h2 id="pilot-form-heading">{strings.heading}</h2>
      <input type="hidden" name="locale" value={locale} />

      <p
        ref={statusRef}
        className={`form-status ${result ? `form-status-${result}` : ''}`}
        role="status"
        tabIndex={-1}
      >
        {result ? strings.result[result] : ''}
      </p>

      <div className="field">
        <label htmlFor="pilot-name">
          {strings.name} <span className="req">({strings.required})</span>
        </label>
        <input
          id="pilot-name"
          name="name"
          type="text"
          autoComplete="name"
          required
          maxLength={PILOT_LIMITS.name}
          aria-invalid={invalid('name') || undefined}
          aria-describedby={describedBy('name')}
        />
        {fieldError('name')}
      </div>

      <div className="field">
        <label htmlFor="pilot-contact">
          {strings.contact} <span className="req">({strings.required})</span>
        </label>
        <input
          id="pilot-contact"
          name="contact"
          type="text"
          autoComplete="email"
          required
          maxLength={PILOT_LIMITS.contact}
          aria-invalid={invalid('contact') || undefined}
          aria-describedby={describedBy('contact', 'pilot-contact-hint')}
        />
        <span className="field-hint" id="pilot-contact-hint">
          {strings.contactHint}
        </span>
        {fieldError('contact')}
      </div>

      <div className="field">
        <label htmlFor="pilot-site">
          {strings.site} <span className="req">({strings.required})</span>
        </label>
        <input
          id="pilot-site"
          name="site"
          type="text"
          inputMode="url"
          autoComplete="url"
          required
          maxLength={PILOT_LIMITS.site}
          aria-invalid={invalid('site') || undefined}
          aria-describedby={describedBy('site', 'pilot-site-hint')}
        />
        <span className="field-hint" id="pilot-site-hint">
          {strings.siteHint}
        </span>
        {fieldError('site')}
      </div>

      <div className="field">
        <label htmlFor="pilot-segment">
          {strings.segment} <span className="req">({strings.required})</span>
        </label>
        <select
          id="pilot-segment"
          name="segment"
          required
          defaultValue=""
          aria-invalid={invalid('segment') || undefined}
          aria-describedby={describedBy('segment')}
        >
          <option value="" disabled>
            —
          </option>
          {PILOT_SEGMENTS.map((s) => (
            <option key={s} value={s}>
              {strings.segments[s]}
            </option>
          ))}
        </select>
        {fieldError('segment')}
      </div>

      <div className="field">
        <label htmlFor="pilot-message">{strings.message}</label>
        <textarea
          id="pilot-message"
          name="message"
          rows={4}
          maxLength={PILOT_LIMITS.message}
          aria-invalid={invalid('message') || undefined}
          aria-describedby={describedBy('message')}
        />
        {fieldError('message')}
      </div>

      {/* Ловушка для ботов: вне экрана и вне порядка табуляции. */}
      <div className="hp" aria-hidden="true">
        <label htmlFor="pilot-hp">{strings.honeypot}</label>
        <input id="pilot-hp" name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="field field-check">
        <input
          id="pilot-consent"
          name="consent"
          type="checkbox"
          value="on"
          required
          aria-invalid={invalid('consent') || undefined}
          aria-describedby={describedBy('consent')}
        />
        <label htmlFor="pilot-consent">
          {strings.consent} <a href={privacyHref}>{strings.consentLink}</a>.
        </label>
        {fieldError('consent')}
      </div>

      <button className="button" type="submit" disabled={busy} aria-busy={busy || undefined}>
        {busy ? strings.sending : strings.submit}
      </button>
    </form>
  );
}
