import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { Alert, Badge, Button } from '../../../kit/ui';
import {
  pollCall,
  type AiCallView,
  type AiStartResponse,
} from '../../../lib/publisher/ai-api';
import { pubError } from '../../../lib/publisher/common-api';
import { describePubError } from '../../../lib/publisher/errors';
import {
  P0_ENABLED_GENERATORS,
  type GeneratorId,
} from '../../../lib/publisher/states';
import { fmtMicroUsd, statusTone } from '../../../lib/publisher/view';
import { useMutation, usePubApis, usePubContent } from '../hooks';
import { PubErrorAlert, TextInput } from '../parts';
import { usePublisher } from '../publisher-context';

/**
 * Запуск AI-операции (§11.1, §12): старт → 200/202 → опрос
 * `GET ai/calls/:callId` (клиент с таймаутом 65 с) до финального статуса;
 * результат — ПРЕДЛОЖЕНИЕ, применяет человек (`render`). Выключенный
 * генератор (ДТ-2, `PUB_AI_DISABLED`) и недоступность — ручной путь
 * (`manualHint`), не «ошибка без выхода». Стоимость `null` — «неизвестно».
 */
export function AiRunner({
  generator,
  start,
  label,
  manualHint,
  render,
  disabled,
  extraInput,
}: {
  generator: GeneratorId;
  start: (opKey: string) => Promise<AiStartResponse>;
  label: string;
  manualHint: ReactNode;
  render: (call: AiCallView) => ReactNode;
  disabled?: boolean;
  extraInput?: ReactNode;
}) {
  const { t, can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const m = useMutation();
  const [call, setCall] = useState<AiCallView | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollError, setPollError] = useState<unknown>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    []
  );
  const enabledInP0 = (P0_ENABLED_GENERATORS as readonly string[]).includes(
    generator
  );

  const follow = async (callId: string) => {
    setPolling(true);
    setPollError(null);
    try {
      const last = await pollCall(apis.ai, callId, {
        cancelled: () => !alive.current,
      });
      if (alive.current) setCall(last);
    } catch (e) {
      if (alive.current) setPollError(e);
    } finally {
      if (alive.current) setPolling(false);
    }
  };

  const limitTaskId = (() => {
    const info = pubError(m.error);
    return info?.code === 'PUB_AI_LIMIT' &&
      typeof info.details.taskId === 'string'
      ? info.details.taskId
      : null;
  })();

  return (
    <div className="space-y-2 rounded-xl border border-dashed border-silver-300 dark:border-silver-700 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={16} className="text-accent" />
        <span className="font-medium text-sm flex-1 min-w-0">{label}</span>
        {!enabledInP0 && <Badge tone="warning">{c.ai.disabledP0}</Badge>}
      </div>
      {!enabledInP0 && (
        <div className="text-xs text-silver-500">{manualHint}</div>
      )}
      {extraInput}
      <Button
        variant="outline"
        loading={m.busy || polling}
        disabled={disabled}
        onClick={async () => {
          setCall(null);
          const r = await m.run((k) => start(k));
          if (!r) return;
          if (r.call && r.call.status !== 'running') setCall(r.call);
          else await follow(r.callId);
        }}
      >
        {c.ai.start}
      </Button>
      {(m.busy || polling) && (
        <div className="text-xs text-silver-500">{c.ai.running}</div>
      )}
      {m.error ? (
        <PubErrorAlert
          error={m.error}
          manualHint={<span className="text-xs">{manualHint}</span>}
        />
      ) : null}
      {limitTaskId && can('ai.extra') && (
        <ExtraGeneration taskId={limitTaskId} />
      )}
      {pollError ? <PubErrorAlert error={pollError} /> : null}
      {call && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={statusTone(call.status)}>
              {c.ai.callStatuses[call.status]}
            </Badge>
            <span className="text-silver-500">
              {c.ai.cost}: {fmtMicroUsd(call.costMicroUsd, t.common.unknown)} (
              {c.ai.costStatuses[call.costStatus]})
            </span>
            <code className="text-silver-500 break-all">{call.callId}</code>
          </div>
          {call.status === 'running' ? (
            <Alert tone="warning">
              {c.ai.stillRunning}
              <div className="mt-2">
                <Button
                  variant="outline"
                  onClick={() => void follow(call.callId)}
                >
                  {t.common.reload}
                </Button>
              </div>
            </Alert>
          ) : call.status === 'ok' && call.output !== null ? (
            <div className="space-y-2">
              <div className="text-xs text-silver-500">{c.ai.proposalHint}</div>
              {call.findings.length > 0 && (
                <Alert tone="warning" title={c.ai.findings}>
                  <ul className="list-disc pl-5">
                    {call.findings.map((f, i) => (
                      <li key={i}>{f.text}</li>
                    ))}
                  </ul>
                </Alert>
              )}
              {render(call)}
            </div>
          ) : (
            <Alert tone="warning" title={c.ai.callStatuses[call.status]}>
              {call.errorCode ? `${c.ai.error}: ${call.errorCode}. ` : ''}
              {manualHint}
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}

/** «Разрешить ещё генерацию» (PUB_AI_LIMIT; ED, PO; §4.2 `ai.extra`). */
function ExtraGeneration({ taskId }: { taskId: string }) {
  const c = usePubContent();
  const apis = usePubApis();
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  const m = useMutation();
  if (done) return <Alert tone="success">{c.ai.extraDone}</Alert>;
  return (
    <div className="space-y-2">
      <TextInput
        value={reason}
        onChange={setReason}
        placeholder={c.ai.extraReason}
        maxLength={500}
      />
      <PubErrorAlert error={m.error} />
      <Button
        variant="outline"
        loading={m.busy}
        disabled={!reason.trim()}
        onClick={async () => {
          const r = await m.run((k) => apis.ai.extra(taskId, reason.trim(), k));
          if (r) setDone(true);
        }}
      >
        {c.ai.extra}
      </Button>
    </div>
  );
}

/**
 * Принять результат вызова (`POST ai/tasks/:id/accept`, Z-1): нужен только
 * для helper-ответов и предложений, которые не записываются мутацией с
 * `aiCallId` (AI-проверка) — мутации P-B1 с `aiCallId` закрывают задачу сами.
 */
export function AcceptCallButton({ call }: { call: AiCallView }) {
  const c = usePubContent();
  const { t } = usePublisher();
  const apis = usePubApis();
  const m = useMutation();
  const [done, setDone] = useState(false);
  // Повтор принятия (`done`) — 409 PUB_TRANSITION_INVALID: результат уже принят.
  const alreadyDone =
    !!m.error && describePubError(m.error, t).code === 'PUB_TRANSITION_INVALID';
  if (done || alreadyDone) {
    return <Badge tone="success">{c.ai.accepted}</Badge>;
  }
  return (
    <div className="space-y-1">
      <Button
        variant="ghost"
        loading={m.busy}
        onClick={async () => {
          const r = await m.run((k) =>
            apis.ai.accept(call.taskId, call.callId, k)
          );
          if (r) setDone(true);
        }}
      >
        {c.ai.accept}
      </Button>
      {m.error && !alreadyDone ? <PubErrorAlert error={m.error} /> : null}
    </div>
  );
}
