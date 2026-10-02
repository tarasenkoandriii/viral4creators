/**
 * Разметка чата (Preact). Тексты — только как дочерние текстовые узлы
 * (Preact экранирует), никакого dangerouslySetInnerHTML (линт). Метка
 * «ИИ · может ошибаться» — всегда, не зависит от конфига (К-6).
 *
 * Э3: ответы оператора отличимы от ИИ — подпись «Оператор», метка «ИИ» —
 * только у ответов модели; передача (подтверждение «~N минут», ожидание с
 * отменой, «оператор в чате»), сценарии (шаги и финал).
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { ChatController, ChatState, UiMessage } from './controller';
import type { Scenario } from '../shared/scenarios';
import type { LangText } from '../shared/engagement';
import { parseMarkdown, safeHref, type Block, type Inline } from './markdown';
import type { SiteAction, SiteAnswerSource } from './api';
import type { LeadField } from '../shared/config';

function Svg({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}
const CLOSE =
  'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z';
const SEND = 'M3 20.5 21 12 3 3.5v6.6l12 1.9-12 1.9z';
// Э5: микрофон, «стоп», динамик.
const MIC =
  'M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V22h2v-3.1a7 7 0 0 0 6-6.9z';
const STOP = 'M7 7h10v10H7z';
const SPEAKER =
  'M4 9v6h4l5 4V5L8 9H4zm12.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z';
const ICONS: Record<string, string> = {
  chat: 'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  question:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 16h-2v-2h2v2zm2.1-7.8-.9.9c-.8.8-1.2 1.4-1.2 2.9h-2v-.5c0-1.1.4-2.1 1.2-2.9l1.2-1.3A2 2 0 1 0 10 8H8a4 4 0 1 1 7.1 2.2z',
  headset:
    'M12 2a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9z',
};

function inlineNodes(list: Inline[]): ComponentChildren[] {
  return list.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'b':
        return <strong key={i}>{inlineNodes(n.c)}</strong>;
      case 'i':
        return <em key={i}>{inlineNodes(n.c)}</em>;
      case 'code':
        return <code key={i}>{n.v}</code>;
      case 'br':
        return <br key={i} />;
      case 'a':
        // Хост сайта: переход в окне сайта (MPA-сценарий «нажал ссылку помощника»).
        return (
          <a key={i} href={n.href} target="_top" rel="noopener noreferrer">
            {inlineNodes(n.c)}
          </a>
        );
    }
  });
}

export function Markdown({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.t === 'p' ? (
          <p key={i}>{inlineNodes(b.c)}</p>
        ) : b.t === 'pre' ? (
          <pre key={i}>{b.v}</pre>
        ) : b.t === 'ul' ? (
          <ul key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inlineNodes(it)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inlineNodes(it)}</li>
            ))}
          </ol>
        )
      )}
    </>
  );
}

function Sources({
  items,
  allowed,
  label,
}: {
  items: SiteAnswerSource[];
  allowed: string[];
  label: string;
}) {
  if (!items.length) return null;
  return (
    <div class="src">
      <span>{label}:</span>
      {items.map((s) => {
        const href = s.url ? safeHref(s.url, allowed) : null;
        const title = `[${s.n}] ${s.title || (href ? new URL(href).pathname : '')}`;
        return href ? (
          <a key={s.n} href={href} target="_top" rel="noopener noreferrer">
            {title}
          </a>
        ) : (
          <span key={s.n}>{title}</span>
        );
      })}
    </div>
  );
}

function Actions({
  items,
  allowed,
  onAction,
  onLink,
}: {
  items: SiteAction[];
  allowed: string[];
  onAction: (a: SiteAction) => void;
  onLink: () => void;
}) {
  if (!items.length) return null;
  return (
    <div class="acts">
      {items.slice(0, 3).map((a, i) => {
        if (a.kind === 'link') {
          const href = safeHref(a.url, allowed);
          return href ? (
            <a
              key={i}
              class="act"
              href={href}
              target="_top"
              rel="noopener noreferrer"
              onClick={onLink}
            >
              {a.label}
            </a>
          ) : null;
        }
        return (
          <button key={i} type="button" class="act" onClick={() => onAction(a)}>
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

function Message({
  m,
  s,
  c,
}: {
  m: UiMessage;
  s: ChatState;
  c: ChatController;
}) {
  const t = s.t;
  if (m.role === 'visitor')
    return (
      <div class="msg me" data-mid={m.id}>
        {m.byVoice && <div class="who">🎤 {t.byVoice}</div>}
        <div class="bub">{m.text}</div>
      </div>
    );
  if (m.role === 'operator' || m.role === 'system')
    return (
      <div
        class={`msg ${m.role === 'operator' ? 'op' : 'sys'}`}
        data-mid={m.id}
      >
        {m.role === 'operator' && <div class="who">{t.operator}</div>}
        <div class="bub">{m.text}</div>
      </div>
    );
  const server = m.id.indexOf('p-') !== 0;
  return (
    <div class="msg bot" data-mid={m.id}>
      <div class="who ai">{t.ai}</div>
      <div class="bub">
        {m.text ? (
          <Markdown blocks={parseMarkdown(m.text, s.allowedOrigins)} />
        ) : (
          <span class="dots" aria-label={t.typing} />
        )}
        <Sources
          items={m.sources}
          allowed={s.allowedOrigins}
          label={t.sources}
        />
        <Actions
          items={m.actions}
          allowed={s.allowedOrigins}
          onAction={(a) => c.actionClicked(a)}
          onLink={() => c.linkClicked()}
        />
      </div>
      {m.streamState === 'partial' && (
        <div class="note">
          {t.retry}{' '}
          <button type="button" class="lnk" onClick={() => c.retry()}>
            {t.retryBtn}
          </button>
        </div>
      )}
      {server && m.streamState === 'complete' && m.text && (
        <div class="fb">
          {s.voice.speak && (
            <button
              type="button"
              class="spk"
              aria-pressed={s.voice.playing === m.id}
              aria-busy={s.voice.loading === m.id}
              aria-label={
                s.voice.playing === m.id || s.voice.loading === m.id
                  ? t.voiceStopSpeak
                  : t.voiceSpeak
              }
              title={t.voiceSpeak}
              onClick={() => c.voice.speak(m.id)}
            >
              <Svg
                d={
                  s.voice.playing === m.id || s.voice.loading === m.id
                    ? STOP
                    : SPEAKER
                }
              />
            </button>
          )}
          {m.rated ? (
            <span>{t.thanks}</span>
          ) : (
            <>
              <button
                type="button"
                aria-label={t.good}
                onClick={() => c.feedback(m.id, 1)}
              >
                👍
              </button>
              <button
                type="button"
                aria-label={t.bad}
                onClick={() => c.feedback(m.id, -1)}
              >
                👎
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const FIELD_TYPES: Record<LeadField, string> = {
  name: 'text',
  phone: 'tel',
  email: 'email',
  comment: 'text',
};

function LeadForm({ s, c }: { s: ChatState; c: ChatController }) {
  const t = s.t;
  const [vals, setVals] = useState<Partial<Record<LeadField, string>>>({
    name: s.prefill.name,
    email: s.prefill.email,
    comment: s.prefill.comment,
  });
  // Ответы сценария квалификации (№40) — в комментарий, который видит посетитель.
  const shown =
    s.prefill.comment && !s.cfg.lead.fields.some((f) => f.field === 'comment')
      ? [...s.cfg.lead.fields, { field: 'comment' as const, required: false }]
      : s.cfg.lead.fields;
  const [consent, setConsent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const label: Record<LeadField, string> = {
    name: t.name_,
    phone: t.phone,
    email: t.email,
    comment: t.comment,
  };
  if (s.lead === 'sent')
    return (
      <div class="lead" role="status">
        {t.leadSent}
      </div>
    );
  const submit = async (e: Event) => {
    e.preventDefault();
    const fields: Partial<Record<LeadField, string>> = {};
    for (const f of shown) {
      const v = (vals[f.field] || '').trim();
      if (f.required && !v) return setErr(t.leadInvalid);
      if (v && f.field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
        return setErr(t.leadInvalid);
      if (
        v &&
        f.field === 'phone' &&
        (v.replace(/\D/g, '').length < 7 || !/^[\d\s()+-]+$/.test(v))
      )
        return setErr(t.leadInvalid);
      if (v) fields[f.field] = v.slice(0, f.field === 'comment' ? 1000 : 200);
    }
    setErr(await c.submitLead(fields, consent));
  };
  const consentText = s.cfg.lead.consentText[s.lang] || t.consentDefault;
  return (
    <form class="lead" onSubmit={submit} noValidate>
      <div class="lt">{t.leadTitle}</div>
      {shown.map((f) => (
        <label key={f.field}>
          <span>
            {label[f.field]}
            {f.required ? ` (${t.required})` : ''}
          </span>
          {f.field === 'comment' ? (
            <textarea
              name={f.field}
              maxLength={1000}
              value={vals[f.field] || ''}
              onInput={(e) =>
                setVals({
                  ...vals,
                  [f.field]: (e.target as HTMLTextAreaElement).value,
                })
              }
            />
          ) : (
            <input
              name={f.field}
              type={FIELD_TYPES[f.field]}
              maxLength={200}
              autoComplete={
                f.field === 'name'
                  ? 'name'
                  : f.field === 'phone'
                    ? 'tel'
                    : f.field === 'email'
                      ? 'email'
                      : 'off'
              }
              required={f.required}
              value={vals[f.field] || ''}
              onInput={(e) =>
                setVals({
                  ...vals,
                  [f.field]: (e.target as HTMLInputElement).value,
                })
              }
            />
          )}
        </label>
      ))}
      <label class="cons">
        <input
          type="checkbox"
          name="consent"
          checked={consent}
          onChange={(e) => setConsent((e.target as HTMLInputElement).checked)}
        />
        <span>{consentText}</span>
      </label>
      {err && (
        <div class="err" role="alert">
          {err}
        </div>
      )}
      <button type="submit" class="pri">
        {t.submit}
      </button>
    </form>
  );
}

function lt(v: LangText, s: ChatState): string {
  return v[s.lang] || v.uk || v.ru || v.en || '';
}

/** Передача человеку: подтверждение, ожидание (с отменой), «оператор в чате». */
function Handoff({ s, c }: { s: ChatState; c: ChatController }) {
  const t = s.t;
  const h = s.handoff;
  if (s.handoffAsk)
    return (
      <div class="note ho" role="alertdialog" aria-label={t.handoffAsk}>
        <span>
          {t.handoffAsk}
          {s.eta ? ` ${s.eta}` : ''}
        </span>
        <button type="button" class="lnk" onClick={() => c.handoff()}>
          {t.handoffYes}
        </button>
        <button type="button" class="lnk" onClick={() => c.cancelAskHandoff()}>
          {t.cancel}
        </button>
      </div>
    );
  if (!h || (h.state !== 'waiting' && h.state !== 'active')) return null;
  return (
    <div class="note ho" role="status" data-handoff={h.state}>
      {h.state === 'waiting' ? (
        <>
          <span>
            {t.handoffWaiting}
            {s.eta ? ` ${s.eta}` : ''}
          </span>
          <button type="button" class="lnk" onClick={() => c.cancelHandoff()}>
            {t.handoffCancel}
          </button>
        </>
      ) : (
        <span>{t.handoffActive}</span>
      )}
    </div>
  );
}

function ScenarioStepView({ s, c }: { s: ChatState; c: ChatController }) {
  const t = s.t;
  const [val, setVal] = useState('');
  const sc = s.scen;
  if (!sc) return null;
  const f = sc.s.final;
  if (sc.done)
    return f.kind === 'link' ? (
      <div class="acts scen">
        {(() => {
          const href = safeHref(f.url, s.allowedOrigins);
          return href ? (
            <a
              class="act"
              href={href}
              target="_top"
              rel="noopener noreferrer"
              onClick={() => c.linkClicked()}
            >
              {lt(f.label, s)}
            </a>
          ) : null;
        })()}
      </div>
    ) : null;
  const step = sc.s.steps[sc.step];
  const a = step.answer;
  const submit = (e: Event) => {
    e.preventDefault();
    const v = val.trim();
    if (a.type === 'number') {
      const n = Number(v.replace(',', '.'));
      if (
        !v ||
        !isFinite(n) ||
        (a.min !== null && n < a.min) ||
        (a.max !== null && n > a.max)
      )
        return;
    } else if (a.type === 'text' && !v) return;
    setVal('');
    c.answerStep(v);
  };
  return (
    <div class="scen" data-step={step.key}>
      <div class="msg bot">
        <div class="bub">{lt(step.question, s)}</div>
      </div>
      {a.type === 'choice' ? (
        <div class="sugg">
          {a.options.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => c.answerStep(lt(o.label, s))}
            >
              {lt(o.label, s)}
            </button>
          ))}
        </div>
      ) : a.type === 'none' ? (
        <div class="sugg">
          <button type="button" onClick={() => c.answerStep('')}>
            {t.next}
          </button>
        </div>
      ) : (
        <form class="sa" onSubmit={submit}>
          <input
            type={a.type === 'number' ? 'number' : 'text'}
            maxLength={a.type === 'text' ? a.maxChars : 30}
            aria-label={lt(step.question, s)}
            value={val}
            onInput={(e) => setVal((e.target as HTMLInputElement).value)}
          />
          <button type="submit" class="pri">
            {t.next}
          </button>
        </form>
      )}
      <button type="button" class="lnk" onClick={() => c.cancelScenario()}>
        {t.cancel}
      </button>
    </div>
  );
}

function ScenarioButtons({
  list,
  s,
  c,
}: {
  list: Scenario[];
  s: ChatState;
  c: ChatController;
}) {
  if (!list.length) return null;
  return (
    <div class="sugg scn">
      {list.map((x) => (
        <button
          key={x.key}
          type="button"
          onClick={() => c.startScenario(x.key)}
        >
          {lt(x.title, s) || x.key}
        </button>
      ))}
    </div>
  );
}

/** Э5: индикатор открытого микрофона — точка, таймер, уровень (§5-бис.7). */
function VoiceBar({ s, c }: { s: ChatState; c: ChatController }) {
  const t = s.t;
  const [, tick] = useState(0);
  useLayoutEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const sec = Math.max(0, Math.floor((Date.now() - s.voice.since) / 1000));
  const rec = s.voice.phase === 'recording';
  return (
    <div class="vbar" role="status" aria-live="polite">
      <span class={`dot ${rec ? 'on' : ''}`} aria-hidden="true" />
      <span>
        {rec ? t.voiceListening : t.voiceSending}
        {rec && ` 0:${sec < 10 ? '0' : ''}${sec}`}
      </span>
      {rec && (
        <span class="lvl" aria-hidden="true">
          <span style={{ width: `${Math.round(s.voice.level * 100)}%` }} />
        </span>
      )}
      {rec && (
        <button type="button" class="lnk" onClick={() => c.voice.press()}>
          {t.voiceStop}
        </button>
      )}
    </div>
  );
}

export function App({
  c,
  onClose,
  focusRef,
}: {
  c: ChatController;
  onClose: () => void;
  focusRef: { current: HTMLTextAreaElement | null };
}) {
  const [s, setS] = useState<ChatState>(c.state);
  // Подписка сразу после монтирования (layout-эффект синхронный): useEffect ждёт
  // кадра, а в скрытом iframe кадров может не быть — первые события терялись бы.
  useLayoutEffect(() => {
    setS(c.state);
    return c.subscribe(() => setS(c.state));
  }, [c]);
  const feed = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const restored = useRef(false);
  const t = s.t;

  useLayoutEffect(() => {
    const el = feed.current;
    if (!el) return;
    if (!restored.current && s.phase === 'ready' && s.messages.length) {
      restored.current = true;
      const id = c.savedScroll();
      const target = id
        ? el.querySelector(`[data-mid="${CSS.escape(id)}"]`)
        : null;
      if (target) {
        target.scrollIntoView({ block: 'end' });
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        return;
      }
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [s.messages, s.lead, s.notice, s.phase]);

  const onScroll = () => {
    const el = feed.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    const bottom = el.scrollTop + el.clientHeight;
    let last: string | null = null;
    el.querySelectorAll('[data-mid]').forEach((n) => {
      const h = n as HTMLElement;
      if (h.offsetTop + h.offsetHeight <= bottom + 2)
        last = h.getAttribute('data-mid');
    });
    c.saveScroll(last);
  };

  if (s.phase === 'unavailable')
    return (
      <div class="v4c-chat" role="dialog" aria-label={t.name}>
        <p class="unav">{t.unavailable}</p>
      </div>
    );

  const v = s.view;
  const name = v.brand.name || t.name;
  const texts = v.texts[s.lang];
  const greeting = (texts && texts.greeting) || t.greeting;
  const suggestions = (
    texts && texts.suggestions.length
      ? texts.suggestions
      : s.cfg.suggestedQuestions
  ).slice(0, 3);
  const avatar = v.brand.avatar;
  const leadOnly = s.cfg.status === 'lead_only';
  const send = (e: Event) => {
    e.preventDefault();
    void c.ask(s.draft);
  };
  return (
    <div
      class={`v4c-chat ${s.dark ? 'dark' : ''} p-${v.brand.preset} ${s.inline ? 'inline' : ''}`}
      role={s.inline ? 'region' : 'dialog'}
      aria-label={name}
    >
      <header class="hd">
        <span class="av" aria-hidden="true">
          {avatar.kind === 'asset' ? (
            <img
              src={`/widget/v1/asset/${encodeURIComponent(avatar.assetId)}`}
              alt=""
            />
          ) : (
            <Svg d={ICONS[avatar.icon] || ICONS.chat} />
          )}
        </span>
        <div class="ttl">
          <div class="nm">
            {v.brand.logoAssetId && (
              <img
                class="logo"
                src={`/widget/v1/asset/${encodeURIComponent(v.brand.logoAssetId)}`}
                alt=""
              />
            )}
            <span>{name}</span>
            <span class="ai">{t.ai}</span>
          </div>
          <div class="sub" data-ai-label>
            {t.ai} · {t.mayErr}
          </div>
        </div>
        {!s.inline && (
          <button
            type="button"
            class="x"
            aria-label={t.close}
            onClick={onClose}
          >
            <Svg d={CLOSE} />
          </button>
        )}
      </header>
      <div
        class="feed"
        ref={feed}
        role="log"
        aria-live="polite"
        onScroll={onScroll}
      >
        <div class="msg bot greet">
          <div class="bub">{greeting}</div>
        </div>
        {s.resumedBanner && (
          <div class="note resume">
            <span>{t.resumed}</span>
            <button type="button" class="lnk" onClick={() => c.dismissResume()}>
              {t.continue}
            </button>
            <button type="button" class="lnk" onClick={() => c.newQuestion()}>
              {t.newQuestion}
            </button>
          </div>
        )}
        {s.messages.map((m) => (
          <Message key={m.id} m={m} s={s} c={c} />
        ))}
        {!s.messages.length &&
          !leadOnly &&
          suggestions.length > 0 &&
          !s.scen && (
            <div class="sugg">
              {suggestions.map((q, i) => (
                <button key={i} type="button" onClick={() => c.ask(q)}>
                  {q}
                </button>
              ))}
            </div>
          )}
        {!s.messages.length && !leadOnly && !s.scen && (
          <ScenarioButtons
            list={s.scenarios.filter((x) => x.showInGreeting)}
            s={s}
            c={c}
          />
        )}
        <ScenarioStepView key={s.scen ? s.scen.s.key : ''} s={s} c={c} />
        <Handoff s={s} c={c} />
        {s.notice && (
          <div class="note" role="status">
            {s.notice.text}
            {s.notice.retry && (
              <>
                {' '}
                <button type="button" class="lnk" onClick={() => c.retry()}>
                  {t.retryBtn}
                </button>
              </>
            )}
          </div>
        )}
        {s.lead !== 'hidden' && <LeadForm s={s} c={c} />}
        {s.voice.phase === 'consent' && (
          <div class="note vconsent" role="alertdialog" aria-label={t.voiceMic}>
            <span>{t.voiceConsent}</span>
            <button
              type="button"
              class="lnk"
              onClick={() => c.voice.consent(true)}
            >
              {t.voiceConsentYes}
            </button>
            <button
              type="button"
              class="lnk"
              onClick={() => c.voice.consent(false)}
            >
              {t.cancel}
            </button>
          </div>
        )}
        {s.confirmForget && (
          <div class="note" role="alertdialog" aria-label={t.forgetAsk}>
            <span>{t.forgetAsk}</span>
            <button type="button" class="lnk" onClick={() => c.forget()}>
              {t.forgetYes}
            </button>
            <button
              type="button"
              class="lnk"
              onClick={() => c.askForget(false)}
            >
              {t.cancel}
            </button>
          </div>
        )}
      </div>
      {!leadOnly &&
        (s.voice.phase === 'recording' || s.voice.phase === 'sending') && (
          <VoiceBar s={s} c={c} />
        )}
      {!leadOnly && (
        <form class="cmp" onSubmit={send}>
          <textarea
            ref={focusRef}
            rows={1}
            maxLength={600}
            aria-label={t.placeholder}
            placeholder={t.placeholder}
            value={s.draft}
            disabled={s.phase !== 'ready'}
            onInput={(e) => c.setDraft((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) send(e);
            }}
          />
          {s.voice.mic && (
            <button
              type="button"
              class={`mic ${s.voice.phase}`}
              aria-pressed={s.voice.phase === 'recording'}
              aria-label={
                s.voice.phase === 'recording'
                  ? t.voiceStop
                  : s.voice.phase === 'paused'
                    ? t.voicePaused
                    : t.voiceMic
              }
              title={s.voice.phase === 'paused' ? t.voicePaused : t.voiceMic}
              disabled={
                s.phase !== 'ready' || s.busy || s.voice.phase === 'sending'
              }
              onClick={() => c.voice.press()}
            >
              <Svg d={s.voice.phase === 'recording' ? STOP : MIC} />
            </button>
          )}
          <button
            type="submit"
            class="snd"
            aria-label={t.send}
            disabled={s.busy || !s.draft.trim() || s.phase !== 'ready'}
          >
            <Svg d={SEND} />
          </button>
        </form>
      )}
      <footer class="ft">
        {s.cfg.handoff &&
          s.cfg.handoff.enabled &&
          !leadOnly &&
          !s.handoffAsk &&
          !(
            s.handoff &&
            (s.handoff.state === 'waiting' || s.handoff.state === 'active')
          ) && (
            <button type="button" class="lnk" onClick={() => c.askHandoff()}>
              {t.callHuman}
            </button>
          )}
        {s.messages.length > 0 && (
          <button type="button" class="lnk" onClick={() => c.askForget(true)}>
            {t.forget}
          </button>
        )}
        {v.brand.poweredBy && s.cfg.poweredByUrl && (
          <a
            class="pw"
            href={s.cfg.poweredByUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t.poweredBy} {new URL(s.cfg.poweredByUrl).hostname}
          </a>
        )}
      </footer>
    </div>
  );
}
