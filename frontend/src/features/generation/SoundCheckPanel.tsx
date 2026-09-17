/**
 * SoundCheckPanel — этап 73, по прямому запросу владельца продукта сразу
 * после рекомендации Gemini для проверки артефактов (AuditPanel рядом):
 * «когда Джемини отсматривает она может и делать саундчек отдельным
 * отчётом». Намеренно ОТДЕЛЬНАЯ панель, не вкладка внутри AuditPanel — это
 * другой вопрос («звучит ли голос по-человечески», не «сломано ли
 * что-то») и другой Gemini-вызов (`common/sound-check.ts`, не
 * `audit-response.ts`). Мотивация — реальная вакансия AI UGC-студии:
 * «голос не должен звучать как ElevenLabs, а как реальный человек-блогер»
 * (тот же скриншот, что уже был поводом выбрать Resemble вместо
 * ElevenLabs, см. doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §1).
 *
 * Ничего не блокирует — как и AuditPanel, чисто информационная проверка;
 * "synthetic"/"ambiguous" вердикт не мешает скачать или опубликовать
 * ролик, просто подсказывает, стоит ли попробовать другой голос.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, Volume2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Busy,
  Card,
  CardHeader,
} from '../../components/ui';
import {
  errorMessage,
  getSoundCheck,
  runSoundCheck,
} from '../../services/projects-api';
import type { SoundCheck, SoundCheckState } from '../../types';
import { useI18n } from '../../lib/i18n-context';

export function SoundCheckPanel({
  sessionId,
  processing = false,
}: {
  sessionId: string;
  /** См. `AuditPanel.processing` — тот же отказ сервера, та же причина. */
  processing?: boolean;
}) {
  const { dict } = useI18n();
  const [state, setState] = useState<SoundCheckState | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSoundCheck(sessionId)
      .then((s) => alive && setState(s))
      .catch(() => alive && setState({ history: [] }));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!processing) setError(null);
  }, [processing]);

  const latest = state?.history[0] ?? null;
  const older = state?.history.slice(1) ?? [];

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setState(await runSoundCheck(sessionId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Volume2 size={18} className="text-accent" />}
        title={dict.soundCheckPanel.title}
        hint={dict.soundCheckPanel.hint}
      />

      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {running ? (
        <Busy
          title={dict.soundCheckPanel.busy}
          hint={dict.soundCheckPanel.busyHint}
        />
      ) : (
        <>
          <Button
            icon={<Volume2 size={14} />}
            onClick={() => void run()}
            disabled={processing}
          >
            {latest
              ? dict.soundCheckPanel.runAgain
              : dict.soundCheckPanel.runFirst}
          </Button>
          {processing && (
            <p className="mt-2 text-xs text-silver-400">
              {dict.auditPanel.waitProcessing}
            </p>
          )}
        </>
      )}

      {latest && !running && (
        <div className="mt-4">
          <SoundCheckBrief check={latest} />
        </div>
      )}

      {older.length > 0 && (
        <details className="mt-3">
          <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-xs text-silver-400 hover:text-accent">
            {dict.soundCheckPanel.historyToggle.replace(
              '{{count}}',
              String(older.length)
            )}
          </summary>
          {older.map((c) => (
            <div key={c.checkId} className="mt-2 opacity-80">
              <SoundCheckBrief check={c} compact />
            </div>
          ))}
        </details>
      )}
    </Card>
  );
}

function SoundCheckBrief({
  check,
  compact,
}: {
  check: SoundCheck;
  compact?: boolean;
}) {
  const { dict } = useI18n();

  if (check.status === 'failed') {
    return (
      <Alert tone="error" title={dict.soundCheckPanel.failedTitle}>
        {check.error ?? dict.soundCheckPanel.failedDefault}
      </Alert>
    );
  }

  if (check.verdict === 'human') {
    return (
      <Alert tone="success" title={dict.soundCheckPanel.verdictHuman}>
        {check.summary}
      </Alert>
    );
  }

  const tone = check.verdict === 'synthetic' ? 'warning' : 'neutral';
  const title =
    check.verdict === 'synthetic'
      ? dict.soundCheckPanel.verdictSynthetic
      : check.verdict === 'ambiguous'
        ? dict.soundCheckPanel.verdictAmbiguous
        : dict.soundCheckPanel.verdictUnknown;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {check.verdict === 'synthetic' ? (
          <AlertTriangle size={14} className="text-amber-500" />
        ) : (
          <HelpCircle size={14} className="text-silver-400" />
        )}
        <span className="text-sm font-semibold">{title}</span>
        {!compact && <Badge tone={tone}>{title}</Badge>}
      </div>
      {check.summary && (
        <p className="mt-1 text-xs text-silver-600 dark:text-silver-300">
          {check.summary}
        </p>
      )}
      {check.notes.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-silver-500">
          {check.notes.map((n, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <CheckCircle2
                size={11}
                className="mt-0.5 shrink-0 text-silver-400"
              />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
