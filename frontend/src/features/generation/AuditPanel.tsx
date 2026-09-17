/**
 * AuditPanel — spec §11 on the "Ролик готов" step: an optional check of
 * the generated video by Gemini for generation artefacts, a brief, and a
 * revised prompt that is dropped into the existing PromptEditor for
 * regeneration (§11.2). «Указать самому» (§11.3) is the same flow with
 * the user typing the problem instead of Gemini finding it.
 *
 * Nothing here blocks download (or, later, publishing): a clean verdict,
 * a found issue and an audit that failed all leave the video exactly as
 * usable as before. The iteration cap (§11.1) is a warning, not a gate.
 */

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  ScanSearch,
  Sparkles,
  UserRound,
  Wand2,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Busy,
  Card,
  CardHeader,
  Field,
  Spinner,
  Textarea,
} from '../../components/ui';
import { LoadError } from '../projects/shared';
import {
  applyAuditFix,
  errorMessage,
  getAudit,
  runAudit,
} from '../../services/projects-api';
import type { AuditState, GenerationPrompt, VideoAudit } from '../../types';
import { useI18n } from '../../lib/i18n-context';
import type { Dictionary } from '../../lib/get-dictionary';

const SEVERITY_TONE = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
} as const;

export function AuditPanel({
  sessionId,
  generatedVideoId,
  onFixApplied,
  processing = false,
}: {
  sessionId: string;
  generatedVideoId: string;
  /**
   * Постобработка ролика (озвучка/обрезка/субтитры) ещё идёт — сервер
   * аудит отклонит («Ролик ещё обрабатывается»), поэтому кнопки
   * неактивны до её конца, а не отвечают ошибкой на нажатие.
   */
  processing?: boolean;
  /** The fix is in the prompt draft — the wizard goes back to the prompt step. */
  onFixApplied: (prompt: GenerationPrompt, state: AuditState) => void;
}) {
  const { dict } = useI18n();
  const [state, setState] = useState<AuditState | null>(null);
  const [running, setRunning] = useState<'auto' | 'manual' | null>(null);
  const [applying, setApplying] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [issue, setIssue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  /**
   * Провал загрузки — отдельное состояние (этап 119, хвост
   * В-5.18…В-5.23). Раньше `catch` подставлял ПРАВДОПОДОБНУЮ пустышку
   * `{ history: [], appliedFixes: 0, limit: 3 }`, и отказ сервера
   * выглядел как «аудита ещё не было»: кнопка предлагала «Провести
   * первый аудит», уже применённая правка исчезала с экрана, а потолок
   * правок брался с потолка — тройка была вписана здесь руками, хотя
   * настоящий зависит от режима.
   */
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  /** Уже показанные данные — читаются внутри эффекта, не в рендере. */
  const hasStateRef = useRef(false);
  hasStateRef.current = state !== null;

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    getAudit(sessionId)
      .then((s) => {
        if (!alive) return;
        setState(s);
        setLoadError(null);
      })
      .catch((e) => {
        if (!alive) return;
        // Если на экране уже есть история, подменять её сообщением об
        // ошибке хуже, чем сказать об ошибке рядом: данные верные,
        // не доехало только обновление.
        if (hasStateRef.current) setError(errorMessage(e));
        else setLoadError(e);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, reloadNonce]);

  // Обработка закончилась — прежний отказ «ещё обрабатывается» больше
  // не актуален.
  useEffect(() => {
    if (!processing) setError(null);
  }, [processing]);

  const latest =
    state?.history.find((a) => a.generatedVideoId === generatedVideoId) ?? null;
  const older = state?.history.filter((a) => a !== latest) ?? [];

  const run = async (text?: string) => {
    setRunning(text ? 'manual' : 'auto');
    setError(null);
    try {
      const s = await runAudit(sessionId, text);
      setState(s);
      setManualOpen(false);
      setIssue('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(null);
    }
  };

  const apply = async (audit: VideoAudit) => {
    setApplying(true);
    setError(null);
    try {
      const r = await applyAuditFix(sessionId, audit.auditId);
      setState(r.state);
      onFixApplied(r.prompt, r.state);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<ScanSearch size={18} className="text-accent" />}
        title={dict.auditPanel.title}
        hint={dict.auditPanel.hint}
        action={
          state && state.appliedFixes > 0 ? (
            <Badge tone={state.overLimit ? 'warning' : 'neutral'}>
              {dict.auditPanel.fixesBadge
                .replace('{{count}}', String(state.appliedFixes))
                .replace('{{limit}}', String(state.limit))}
            </Badge>
          ) : undefined
        }
      />

      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Три разных экрана вместо двух: «не загрузилось» больше не
          притворяется «ещё не было» (этап 119). */}
      {!state && loadError ? (
        <LoadError
          error={loadError}
          onRetry={() => setReloadNonce((n) => n + 1)}
        />
      ) : !state ? (
        <div className="flex justify-center py-6">
          <Spinner size={20} />
        </div>
      ) : running ? (
        <Busy
          title={
            running === 'auto'
              ? dict.auditPanel.busyAuto
              : dict.auditPanel.busyManual
          }
          hint={dict.auditPanel.busyHint}
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              icon={<ScanSearch size={14} />}
              onClick={() => void run()}
              disabled={applying || processing}
            >
              {latest ? dict.auditPanel.runAgain : dict.auditPanel.runFirst}
            </Button>
            <Button
              variant="outline"
              icon={<UserRound size={14} />}
              onClick={() => setManualOpen((v) => !v)}
              disabled={applying || processing}
              active={manualOpen}
            >
              {dict.auditPanel.manualToggle}
            </Button>
          </div>
          {processing && (
            <p className="mt-2 text-xs text-silver-400">
              {dict.auditPanel.waitProcessing}
            </p>
          )}

          {manualOpen && (
            <form
              className="mt-3 space-y-2 rounded-xl border border-accent/30 bg-accent/5 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (issue.trim().length >= 3) void run(issue.trim());
              }}
            >
              <Field
                label={dict.auditPanel.manualQuestion}
                htmlFor="audit-issue"
                hint={dict.auditPanel.manualHint}
                counter={`${issue.length}/1000`}
              >
                <Textarea
                  id="audit-issue"
                  rows={3}
                  value={issue}
                  onChange={(e) => setIssue(e.target.value.slice(0, 1000))}
                  autoFocus
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setManualOpen(false)}
                >
                  {dict.auditPanel.cancel}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  icon={<Wand2 size={14} />}
                  disabled={issue.trim().length < 3 || processing}
                >
                  {dict.auditPanel.suggestFix}
                </Button>
              </div>
            </form>
          )}
        </>
      )}

      {latest && !running && (
        <div className="mt-4">
          <AuditBrief audit={latest} />

          {latest.promptFix && (
            <div className="mt-3 rounded-xl border border-silver-200/70 p-3 dark:border-silver-800">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <Wand2 size={14} className="text-accent" />
                {dict.auditPanel.suggestedFixTitle}
              </div>
              {latest.promptFix.rationale && (
                <p className="mb-2 text-xs text-silver-500">
                  {latest.promptFix.rationale}
                </p>
              )}
              <details className="mb-3">
                <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-xs text-accent hover:underline">
                  {dict.auditPanel.showPromptText}
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-silver-200/60 bg-silver-100/60 p-3 font-mono text-xs text-silver-600 dark:border-silver-800 dark:bg-silver-950/60 dark:text-silver-300">
                  {latest.promptFix.suggestedText}
                </pre>
              </details>

              {state?.overLimit && (
                <Alert tone="warning" className="mb-3">
                  {dict.auditPanel.overLimitWarning
                    .replace('{{count}}', String(state.appliedFixes))
                    .replace('{{limit}}', String(state.limit))}
                </Alert>
              )}

              <Button
                block
                icon={<Sparkles size={14} />}
                loading={applying}
                onClick={() => void apply(latest)}
              >
                {dict.auditPanel.applyFix}
              </Button>
              <p className="mt-1 text-center text-[11px] text-silver-400">
                {dict.auditPanel.applyFixHint}
              </p>
            </div>
          )}
        </div>
      )}

      {older.length > 0 && (
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="mt-3 inline-flex items-center gap-1 text-xs text-silver-400 hover:text-accent"
        >
          {showHistory ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {dict.auditPanel.historyToggle.replace(
            '{{count}}',
            String(older.length)
          )}
        </button>
      )}
      {showHistory &&
        older.map((a) => (
          <div key={a.auditId} className="mt-2 opacity-80">
            <AuditBrief audit={a} compact />
          </div>
        ))}
    </Card>
  );
}

function AuditBrief({
  audit,
  compact,
}: {
  audit: VideoAudit;
  compact?: boolean;
}) {
  const { dict, locale } = useI18n();
  const SEVERITY_LABEL = {
    high: dict.auditPanel.severityHigh,
    medium: dict.auditPanel.severityMedium,
    low: dict.auditPanel.severityLow,
  };
  if (audit.status === 'failed') {
    return (
      <Alert tone="error" title={dict.auditPanel.auditFailedTitle}>
        {audit.error ?? dict.auditPanel.auditFailedDefault}
      </Alert>
    );
  }
  if (audit.verdict === 'clean') {
    return (
      <Alert tone="success" title={dict.auditPanel.cleanTitle}>
        {audit.summary}
        {compact && <TimeStamp audit={audit} locale={locale} />}
      </Alert>
    );
  }
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle size={14} className="text-amber-500" />
        <span className="text-sm font-semibold">
          {audit.source === 'user'
            ? dict.auditPanel.foundByUser
            : dict.auditPanel.foundByGemini}
          : {audit.issues.length} {pluralIssues(audit.issues.length, dict)}
        </span>
        {audit.verdict === 'unknown' && (
          <Badge tone="neutral">{dict.auditPanel.unparsedVerdict}</Badge>
        )}
        {compact && <TimeStamp audit={audit} locale={locale} />}
      </div>
      {audit.summary && (
        <p className="mt-1 text-xs text-silver-600 dark:text-silver-300">
          {audit.summary}
        </p>
      )}
      {audit.issues.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {audit.issues.map((i) => (
            <li key={i.id} className="flex items-start gap-2 text-xs">
              <Badge tone={SEVERITY_TONE[i.severity]}>
                {SEVERITY_LABEL[i.severity]}
              </Badge>
              {i.timecode && (
                <span className="inline-flex items-center gap-0.5 font-mono text-silver-400 tabular">
                  <Clock size={10} /> {i.timecode}
                </span>
              )}
              <span>
                {i.category !== 'other' && i.category !== 'user' && (
                  <span className="text-silver-400">{i.category} · </span>
                )}
                {i.description}
              </span>
            </li>
          ))}
        </ul>
      )}
      {audit.verdict === 'issues' && !audit.promptFix && !compact && (
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-silver-400">
          <CheckCircle2 size={12} /> {dict.auditPanel.noFixSuggested}
        </p>
      )}
    </div>
  );
}

const INTL_LOCALE: Record<string, string> = {
  ru: 'ru-RU',
  uk: 'uk-UA',
  en: 'en-US',
  de: 'de-DE',
  es: 'es-ES',
};

function TimeStamp({ audit, locale }: { audit: VideoAudit; locale: string }) {
  const d = audit.completedAt ?? audit.requestedAt;
  return (
    <span className="ml-auto text-[11px] text-silver-400 tabular">
      {new Date(d).toLocaleString(INTL_LOCALE[locale] ?? 'ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
      })}
    </span>
  );
}

function pluralIssues(n: number, dict: Dictionary): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return dict.auditPanel.issueOne;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14))
    return dict.auditPanel.issueFew;
  return dict.auditPanel.issueMany;
}
