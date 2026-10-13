'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import AltContact from '@/components/AltContact';
import { PUBLIC_API_PREFIX } from '@/brand';
import type { AltContact as Alt, ConsentState } from '@/lib/api-types';
import { safeSessionStorage, type AnalyticsStorage } from '@/lib/attribution';
import { leadAttribution } from '@/lib/lead-attribution';
import type { Dictionary } from '@/lib/dict';
import {
  EMPTY_FIELDS,
  LEAD_BUDGET_RANGES,
  LEAD_CONTACT_METHODS,
  LEAD_SELF_REPORTED_CHANNELS,
  buildBody,
  classifyResponse,
  fingerprint,
  firstInvalid,
  validateFields,
  waitParts,
  type FieldErrors,
  type FieldName,
  type LeadContext,
  type LeadFields,
  type SubmitOutcome,
} from '@/lib/lead-form';

/**
 * Форма обращения (§13.4; ТЗ §8.3, §19). Поля живут в состоянии React —
 * в localStorage/sessionStorage контакты не пишутся; при ЛЮБОМ неуспехе
 * (ошибка поля, 429, 503, 5xx, обрыв) данные остаются в форме, очищаются
 * только после успеха. `submissionKey` создаётся при первой отправке и
 * переиспользуется повтором той же попытки; правка полей — новый ключ.
 * Повторный клик во время отправки заблокирован. Успех — только по ответу
 * сервера с `leadRef`; событие `lead_submit_success` создаёт сервер.
 */

type Status = 'idle' | 'submitting' | 'success' | 'validation' | 'rate_limited' | 'closed' | 'network' | 'server';

export interface LeadFormProps {
  apiOrigin: string;
  publicKey: string;
  dataNoticeVersion: string;
  consentState: ConsentState;
  analyticsStorage: AnalyticsStorage;
  altContact: Alt | null;
  formLimit: { count: number; windowSec: number };
  /** Срок ответа по параметру `contact_sla` (текст словаря по правилу). */
  sla: string;
  t: Dictionary['form'];
  chrome: { altContact: string; altContactMissing: string; newTab: string };
}

const TIMEOUT_MS = 20_000;
const SLUG_RE = /^[a-z0-9-]{3,80}$/;
const fill = (s: string, v: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

function altOf(raw: unknown, fallback: Alt | null): Alt | null {
  if (raw && typeof raw === 'object' && typeof (raw as Alt).label === 'string') {
    const r = raw as Alt;
    const href = typeof r.href === 'string' && /^(https:\/\/|mailto:|tel:)\S+$/.test(r.href) ? r.href : null;
    return { label: r.label, href };
  }
  return fallback;
}

export default function LeadForm(p: LeadFormProps) {
  const { t } = p;
  const [fields, setFields] = useState<LeadFields>(EMPTY_FIELDS);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<Status>('idle');
  const [leadRef, setLeadRef] = useState('');
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [serverAlt, setServerAlt] = useState<Alt | null>(null);
  const [hp, setHp] = useState('');
  const [ready, setReady] = useState(false);
  /** Число завершённых попыток (`data-done`) — e2e отличает новый исход от прежнего. */
  const [done, setDone] = useState(0);
  const attempt = useRef<{ key: string; fp: string } | null>(null);
  const busy = useRef(false);
  const startedAt = useRef(0);
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    startedAt.current = Date.now();
    setReady(true); // `data-ready` — признак гидратации для axe/e2e
  }, []);

  const context = useCallback((): LeadContext => {
    const loc = window.location;
    const material = new URLSearchParams(loc.search).get('material') ?? '';
    return {
      publicKey: p.publicKey,
      dataNoticeVersion: p.dataNoticeVersion,
      consentState: p.consentState,
      contentSlug: SLUG_RE.test(material) ? material : undefined,
      attribution: leadAttribution(p.analyticsStorage, safeSessionStorage(), loc),
      elapsedMs: Date.now() - startedAt.current,
      hp,
    };
  }, [p.publicKey, p.dataNoticeVersion, p.consentState, p.analyticsStorage, hp]);

  const focusField = (name: FieldName) => {
    const el = document.getElementById(name === 'contactMethod' ? 'lf-method-email' : `lf-${name}`);
    el?.focus();
  };

  const finish = (outcome: SubmitOutcome) => {
    setDone((d) => d + 1);
    switch (outcome.kind) {
      case 'success':
        setLeadRef(outcome.leadRef);
        setFields(EMPTY_FIELDS);
        setErrors({});
        attempt.current = null;
        setStatus('success');
        break;
      case 'validation': {
        setErrors(outcome.errors);
        setStatus('validation');
        const first = firstInvalid(outcome.errors);
        if (first) requestAnimationFrame(() => focusField(first));
        return;
      }
      case 'rate_limited':
        setRetryAfter(outcome.retryAfterSec);
        setServerAlt(altOf(outcome.altContact, p.altContact));
        setStatus('rate_limited');
        break;
      case 'closed':
        setServerAlt(altOf(outcome.altContact, p.altContact));
        setStatus('closed');
        break;
      case 'reused':
        attempt.current = null;
        setStatus('server');
        break;
      default:
        setStatus(outcome.kind);
    }
    requestAnimationFrame(() => statusRef.current?.focus());
  };

  const send = async (key: string) => {
    if (busy.current) return;
    busy.current = true;
    setStatus('submitting');
    const ctx = context();
    const body = buildBody(fields, ctx, key);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let outcome: SubmitOutcome;
    try {
      const res = await fetch(`${p.apiOrigin}${PUBLIC_API_PREFIX}/leads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-language': 'uk' },
        body: JSON.stringify(body),
        credentials: 'omit',
        signal: ctrl.signal,
      });
      const json: unknown = await res.json().catch(() => null);
      outcome = classifyResponse(res.status, json, fields.contactMethod, res.headers.get('retry-after'));
    } catch {
      outcome = { kind: 'network' };
    } finally {
      clearTimeout(timer);
    }
    busy.current = false;
    finish(outcome);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    const errs = validateFields(fields, context());
    const first = firstInvalid(errs);
    if (first) {
      setErrors(errs);
      setStatus('validation');
      setDone((d) => d + 1);
      focusField(first);
      return;
    }
    setErrors({});
    const fp = fingerprint(fields);
    if (!attempt.current || attempt.current.fp !== fp) attempt.current = { key: crypto.randomUUID(), fp };
    void send(attempt.current.key);
  };

  const onRetry = () => {
    if (attempt.current && attempt.current.fp === fingerprint(fields)) void send(attempt.current.key);
    else statusRef.current?.closest('form')?.requestSubmit();
  };

  const set =
    (name: keyof LeadFields) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const value = e.target.value;
      setFields((f) => ({ ...f, [name]: value }));
      if (errors[name]) setErrors((x) => ({ ...x, [name]: undefined }));
      // Номер успешного обращения остаётся на экране до следующей отправки (аудит S3-8).
    };

  const err = (name: FieldName) => (errors[name] ? t.errors[errors[name]!] : null);
  const described = (name: FieldName, hint: boolean) =>
    [hint ? `lf-${name}-hint` : '', errors[name] ? `lf-${name}-error` : ''].filter(Boolean).join(' ') || undefined;
  const errorText = (name: FieldName) =>
    errors[name] ? (
      <p id={`lf-${name}-error`} className="field-error">
        {err(name)}
      </p>
    ) : null;
  const req = (
    <span className="req" aria-hidden="true">
      {' '}
      *
    </span>
  );
  const method = fields.contactMethod;
  const submitting = status === 'submitting';
  const alt = serverAlt ?? p.altContact;
  const wait = waitParts(retryAfter);
  const windowMin = Math.max(1, Math.round(p.formLimit.windowSec / 60));

  let message: string | null = null;
  if (status === 'success') message = fill(t.success, { leadRef, sla: p.sla });
  else if (status === 'validation') message = t.summary;
  else if (status === 'network') message = t.network;
  else if (status === 'server') message = t.server;
  else if (status === 'closed') message = t.closed;
  else if (status === 'rate_limited') {
    message = fill(t.rateLimited, {
      count: p.formLimit.count,
      window: fill(t.minutes, { n: windowMin }),
      wait: fill(wait.unit === 'minutes' ? t.minutes : t.seconds, { n: wait.n }),
    });
  }
  const failed = status === 'network' || status === 'server' || status === 'rate_limited' || status === 'closed';

  return (
    <form
      className="lead-form"
      method="post"
      noValidate
      onSubmit={onSubmit}
      aria-busy={submitting}
      data-ready={ready ? '1' : undefined}
    >
      <div
        ref={statusRef}
        tabIndex={-1}
        className={`form-status${message ? ` form-status-${status}` : ''}`}
        role={status === 'success' ? 'status' : 'alert'}
        data-testid="form-status"
        data-status={status}
        data-done={done}
      >
        {message ? <p>{message}</p> : null}
        {failed ? <AltContact value={alt} label={p.chrome.altContact} missing={p.chrome.altContactMissing} /> : null}
        {status === 'network' || status === 'server' ? (
          <button type="button" className="button-secondary" onClick={onRetry} disabled={submitting}>
            {t.retry}
          </button>
        ) : null}
      </div>

      {/*
        До гидратации и во время отправки поля и кнопка выключены (аудит S2-1,
        S3-6): ввод до гидратации стёрся бы, Enter отправил бы нативный POST,
        а правка во время отправки молча потерялась бы.
      */}
      <fieldset className="lf-fields" disabled={!ready || submitting}>
        <div className="field">
          <label htmlFor="lf-name">
            {t.name}
            {req}
          </label>
          <input
            id="lf-name"
            name="name"
            autoComplete="name"
            value={fields.name}
            onChange={set('name')}
            aria-required="true"
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={described('name', false)}
          />
          {errorText('name')}
        </div>

        <fieldset className="field" aria-describedby={described('contactMethod', false)}>
          <legend>
            {t.method}
            {req}
          </legend>
          <div className="choices">
            {LEAD_CONTACT_METHODS.map((m) => (
              <label key={m} className="choice">
                <input
                  type="radio"
                  id={`lf-method-${m}`}
                  name="contactMethod"
                  value={m}
                  checked={method === m}
                  onChange={set('contactMethod')}
                />
                {t.methods[m]}
              </label>
            ))}
          </div>
          {errorText('contactMethod')}
        </fieldset>

        <div className="field">
          <label htmlFor="lf-contact">
            {method ? t.contact[method] : t.contact.other}
            {req}
          </label>
          <input
            id="lf-contact"
            name="contact"
            type={method === 'email' ? 'email' : method === 'phone' ? 'tel' : 'text'}
            inputMode={method === 'email' ? 'email' : method === 'phone' ? 'tel' : undefined}
            autoComplete={method === 'email' ? 'email' : method === 'phone' ? 'tel' : 'off'}
            value={fields.contact}
            onChange={set('contact')}
            aria-required="true"
            aria-invalid={errors.contact ? true : undefined}
            aria-describedby={described('contact', true)}
          />
          <p id="lf-contact-hint" className="hint">
            {t.contactHint[method || 'other']}
          </p>
          {errorText('contact')}
        </div>

        <div className="field">
          <label htmlFor="lf-business">
            {t.business}
            {req}
          </label>
          <input
            id="lf-business"
            name="business"
            autoComplete="url"
            value={fields.business}
            onChange={set('business')}
            aria-required="true"
            aria-invalid={errors.business ? true : undefined}
            aria-describedby={described('business', true)}
          />
          <p id="lf-business-hint" className="hint">
            {t.businessHint}
          </p>
          {errorText('business')}
        </div>

        <div className="field">
          <label htmlFor="lf-task">
            {t.task}
            {req}
          </label>
          <textarea
            id="lf-task"
            name="task"
            rows={6}
            value={fields.task}
            onChange={set('task')}
            aria-required="true"
            aria-invalid={errors.task ? true : undefined}
            aria-describedby={described('task', true)}
          />
          <p id="lf-task-hint" className="hint">
            {t.taskHint}{' '}
            <span className="counter">{fill(t.taskCounter, { n: Array.from(fields.task).length, max: 2000 })}</span>
          </p>
          {errorText('task')}
        </div>

        <div className="field">
          <label htmlFor="lf-budgetRange">{t.budget}</label>
          <select
            id="lf-budgetRange"
            name="budgetRange"
            value={fields.budgetRange}
            onChange={set('budgetRange')}
            aria-invalid={errors.budgetRange ? true : undefined}
            aria-describedby={described('budgetRange', false)}
          >
            <option value="">{t.budgetNone}</option>
            {LEAD_BUDGET_RANGES.map((b) => (
              <option key={b} value={b}>
                {t.budgets[b]}
              </option>
            ))}
          </select>
          {errorText('budgetRange')}
        </div>

        <div className="field">
          <label htmlFor="lf-selfReported">{t.source}</label>
          <select
            id="lf-selfReported"
            name="selfReported"
            value={fields.selfReported}
            onChange={set('selfReported')}
            aria-invalid={errors.selfReported ? true : undefined}
            aria-describedby={described('selfReported', false)}
          >
            <option value="">{t.sourceNone}</option>
            {LEAD_SELF_REPORTED_CHANNELS.map((s) => (
              <option key={s} value={s}>
                {t.sources[s]}
              </option>
            ))}
          </select>
          {errorText('selfReported')}
        </div>

        <div className="hp" aria-hidden="true">
          <label htmlFor="lf-hp">{t.trap}</label>
          <input
            id="lf-hp"
            name="lf_hp_ref"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={hp}
            onChange={(e) => setHp(e.target.value)}
          />
        </div>

        <p className="notice">
          {t.notice}{' '}
          <a href="/privacy" target="_blank" rel="noopener">
            {t.noticeLink} <span className="visually-hidden">{p.chrome.newTab}</span>
          </a>
        </p>

        <button type="submit" className="cta">
          {submitting ? t.submitting : t.submit}
        </button>
      </fieldset>
    </form>
  );
}
