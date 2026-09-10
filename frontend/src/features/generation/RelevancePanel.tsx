/**
 * RelevancePanel — "стоит ли клонировать этот референс под этот товар"
 * (spec §18.3, Stage 23). Sits at the top of the prompt step, before the
 * prompt is generated: one cheap Gemini text call compares the product's
 * audience (from the photo / the user) with the reference's (from the
 * analysis) and returns a score, a verdict, the reasoning, the gaps and
 * concrete adjustments. The advice feeds the prompt writer as an
 * AUDIENCE FIT section unless the user switches that off here.
 *
 * Runs automatically once when the step opens (if no report exists yet);
 * «Проверить ещё раз» re-runs after the product or audience was edited.
 */

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Scale,
  Wand2,
  XCircle,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Spinner,
} from '../../components/ui';
import {
  errorMessage,
  getRelevance,
  runRelevance,
  setRelevanceUseInPrompt,
} from '../../services/projects-api';
import type { RelevanceState, RelevanceVerdict } from '../../types';
import { scoreColor } from '../../lib/audience';
import { useI18n } from '../../lib/i18n-context';

export function RelevancePanel({
  sessionId,
  onChooseAnother,
}: {
  sessionId: string;
  /** «Выбрать другой референс» — back to the upload step. */
  onChooseAnother?: () => void;
}) {
  const { dict } = useI18n();
  const VERDICT: Record<
    RelevanceVerdict,
    {
      label: string;
      tone: 'success' | 'warning' | 'danger';
      icon: JSX.Element;
    }
  > = {
    use: {
      label: dict.relevancePanel.verdicts.use,
      tone: 'success',
      icon: <CheckCircle2 size={12} />,
    },
    adapt: {
      label: dict.relevancePanel.verdicts.adapt,
      tone: 'warning',
      icon: <AlertTriangle size={12} />,
    },
    skip: {
      label: dict.relevancePanel.verdicts.skip,
      tone: 'danger',
      icon: <XCircle size={12} />,
    },
  };
  const [state, setState] = useState<RelevanceState | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReasoning, setShowReasoning] = useState(false);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setState(await runRelevance(sessionId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    let alive = true;
    getRelevance(sessionId)
      .then((s) => {
        if (!alive) return;
        setState(s);
        if (!s.report) void run();
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const toggleUse = async () => {
    if (!state) return;
    try {
      setState(await setRelevanceUseInPrompt(sessionId, !state.useInPrompt));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const report = state?.report ?? null;

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Scale size={18} className="text-accent" />}
        title={dict.relevancePanel.title}
        hint={dict.relevancePanel.hint}
      />

      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!report && (running || state === null) && !error && (
        <div className="flex items-center gap-2 py-3 text-xs text-silver-400">
          <Spinner size={14} /> {dict.relevancePanel.comparing}
        </div>
      )}

      {!report && !running && state !== null && (
        <Button block variant="outline" onClick={() => void run()}>
          {dict.relevancePanel.checkButton}
        </Button>
      )}

      {report && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex items-baseline gap-1">
              <span className="font-mono text-3xl font-bold tabular">
                {report.score}
              </span>
              <span className="text-xs text-silver-400">/100</span>
            </div>
            <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-silver-200/70 dark:bg-silver-800">
              <div
                className={`h-full rounded-full transition-all ${scoreColor(report.score)}`}
                style={{ width: `${report.score}%` }}
              />
            </div>
            <button
              type="button"
              aria-label={dict.relevancePanel.recheck}
              title={dict.relevancePanel.recheck}
              onClick={() => void run()}
              disabled={running}
              className="shrink-0 rounded-lg p-1.5 text-silver-400 hover:text-accent disabled:opacity-50"
            >
              <RefreshCw size={14} className={running ? 'animate-spin' : ''} />
            </button>
          </div>
          <Badge tone={VERDICT[report.verdict].tone}>
            {VERDICT[report.verdict].icon} {VERDICT[report.verdict].label}
          </Badge>

          <p className="text-sm leading-relaxed">{report.summary}</p>

          {(!report.inputs.productAudience || !report.inputs.videoAudience) && (
            <Alert tone="info">
              {!report.inputs.productAudience && !report.inputs.videoAudience
                ? dict.relevancePanel.noAudienceBoth
                : !report.inputs.productAudience
                  ? dict.relevancePanel.noAudienceProduct
                  : dict.relevancePanel.noAudienceVideo}
            </Alert>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {report.matches.length > 0 && (
              <List
                title={dict.relevancePanel.matchesTitle}
                items={report.matches}
                tone="text-emerald-500"
              />
            )}
            {report.gaps.length > 0 && (
              <List
                title={dict.relevancePanel.gapsTitle}
                items={report.gaps}
                tone="text-rose-500"
              />
            )}
          </div>

          {report.reasoning.length > 0 && (
            <div>
              <button
                type="button"
                className="text-xs text-accent underline"
                onClick={() => setShowReasoning((v) => !v)}
              >
                {showReasoning
                  ? dict.relevancePanel.hideReasoning
                  : dict.relevancePanel.showReasoning}
              </button>
              {showReasoning && (
                <ul className="mt-2 space-y-1 text-xs text-silver-500 dark:text-silver-400">
                  {report.reasoning.map((r, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-silver-400">{i + 1}.</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {(report.adjustments.length > 0 || report.promptAdvice) && (
            <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
              <div className="mb-2 flex items-center gap-2">
                <Wand2 size={14} className="text-accent" />
                <span className="label !mb-0">
                  {dict.relevancePanel.adjustmentsTitle}
                </span>
                <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-silver-500">
                  <input
                    type="checkbox"
                    checked={state?.useInPrompt ?? true}
                    onChange={() => void toggleUse()}
                    className="accent-sky-400"
                  />
                  {dict.relevancePanel.useInPromptLabel}
                </label>
              </div>
              {report.adjustments.length > 0 && (
                <ul className="space-y-1 text-xs">
                  {report.adjustments.map((a, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-accent">•</span>
                      <span>{a}</span>
                    </li>
                  ))}
                </ul>
              )}
              {report.promptAdvice && (
                <p className="mt-2 rounded-lg bg-silver-100/70 p-2 font-mono text-[11px] leading-relaxed text-silver-600 dark:bg-silver-950/60 dark:text-silver-300">
                  {report.promptAdvice}
                </p>
              )}
              <p className="mt-2 text-[11px] text-silver-400">
                {state?.useInPrompt
                  ? dict.relevancePanel.useInPromptOnNote
                  : dict.relevancePanel.useInPromptOffNote}
              </p>
            </div>
          )}

          {report.verdict === 'skip' && onChooseAnother && (
            <Button
              block
              variant="outline"
              icon={<RefreshCw size={14} />}
              onClick={onChooseAnother}
            >
              {dict.relevancePanel.chooseAnother}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function List({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: string;
}) {
  return (
    <div className="rounded-xl border border-silver-200/70 p-3 dark:border-silver-800">
      <span className={`label !mb-1 ${tone}`}>{title}</span>
      <ul className="space-y-1 text-xs">
        {items.map((m, i) => (
          <li key={i} className="flex gap-2">
            <span className={tone}>•</span>
            <span>{m}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
