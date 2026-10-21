'use client';

// «FFmpeg: обработка» — операционная вкладка собственного FFmpeg-сервера
// (ТЗ docs-tz/FFmpeg-server-spec-v1.1-RU.md §13.1). Браузер ходит только в
// backend `/api/admin/ffmpeg/*` (admin-session cookie); ключ VPS остаётся
// секретом backend, прямого доступа к VPS из браузера нет.
//
// Сводка, задачи (курсор, фильтры в адресе), карточка задачи (`?job=`),
// лимиты/маршрутизация/журнал. Автообновление — только видимой вкладки,
// раз в 10 с, с backoff; GET ничего не меняет. Каждое действие — диалог с
// влиянием, причиной и одним requestId; права проверяет сервер (403 —
// понятный текст), спрятанная кнопка защитой не считается.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAdminAuth } from '../../lib/admin-auth-context';
import {
  FFMPEG_REFRESH_MS,
  STATE_LABEL,
  cancelFfmpegJob,
  cleanJobId,
  ffmpegControl,
  filtersToQuery,
  filtersToSearch,
  getFfmpegJob,
  getFfmpegLimits,
  getFfmpegOverview,
  kyivTime,
  listFfmpegJobs,
  parseFilters,
  purgeFfmpegJob,
  reconcileFfmpegJob,
  setFfmpegLimits,
  setFfmpegRouting,
  type FfmpegFilters,
  type LimitChange,
  type RoutingChange,
} from '../../lib/ffmpeg';
import type { FfmpegJobDetail, FfmpegOverview, FfmpegProduct, FfmpegProvider, FfmpegRouting } from '../../lib/types';
import { ActionDialog, type ActionSpec } from './ActionDialog';
import { JobCard } from './JobCard';
import { JobsPanel } from './JobsPanel';
import { LimitsPanel, limitsEffect, routingEffect } from './LimitsPanel';
import { OverviewPanel } from './OverviewPanel';
import { usePoll } from './usePoll';

export default function FfmpegPage() {
  // useSearchParams в app router требует границу Suspense для сборки.
  return (
    <Suspense fallback={null}>
      <FfmpegPageInner />
    </Suspense>
  );
}

function controlSpec(action: 'pause' | 'drain' | 'resume', overview: FfmpegOverview | null): ActionSpec {
  const jobs = overview?.jobs.value;
  const active = jobs ? `${jobs.active}` : 'неизвестно сколько';
  const queued = jobs ? `${jobs.queued}` : 'неизвестно сколько';
  const ready = overview?.ready.value;
  if (action === 'pause')
    return {
      kind: 'pause',
      title: 'Поставить worker на паузу',
      confirmLabel: 'Поставить на паузу',
      right: 'operate',
      effect: (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>Worker перестанет брать новые задачи из очереди. Активная задача ({active}) продолжит выполняться до конца.</li>
          <li>
            Приём новых задач остаётся открытым: ожидающие ({queued}) копятся до лимита очереди и могут истечь по сроку ожидания (QUEUE_TIMEOUT).
          </li>
          <li>Статус, отмена и удаление файлов продолжают работать. Режим сохраняется на диске и переживает рестарт.</li>
        </ul>
      ),
      run: (operationId, reason) => ffmpegControl('pause', { operationId, reason }),
    };
  if (action === 'drain')
    return {
      kind: 'drain',
      title: 'Drain: закрыть приём и дать активной завершиться',
      confirmLabel: 'Включить drain',
      right: 'operate',
      danger: true,
      effect: (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            Новые задачи сервер не примет (503 до приёма). Повтор уже принятого ключа по-прежнему вернёт прежнюю задачу — продукты не потеряют
            принятые операции.
          </li>
          <li>Активная задача ({active}) завершится; новые из очереди ({queued}) не стартуют, пока не нажмут «Продолжить».</li>
          <li>Автоматического переключения на hosted нет: продукты с выбранным selfhosted получат отказ до приёма.</li>
        </ul>
      ),
      run: (operationId, reason) => ffmpegControl('drain', { operationId, reason }),
    };
  if (overview?.acceptMode.value === 'recovery')
    return {
      kind: 'resume-recovery',
      title: 'Выйти из recovery: очередь сверена с продуктовой БД',
      confirmLabel: 'Подтвердить сверку и продолжить',
      right: 'configure',
      danger: true,
      effect: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            Сервер в режиме восстановления после потери или восстановления БД: приём новых задач закрыт, пока принятые задачи не сверены с
            продуктовой БД. После подтверждения worker продолжит очередь ({queued}).
          </p>
          <p style={{ margin: 0 }}>
            Перед подтверждением: каждая операция продукта, чей ключ мог потеряться, помечена и сверена вручную; невосстановимые — UNKNOWN.
            Иначе возможен повтор уже выполненной обработки. Нужно право ffmpeg.configure.
          </p>
        </>
      ),
      checks: ['Подтверждаю: очередь сверена с продуктовой БД, потерянные операции помечены, повторных обработок не будет'],
      run: (operationId, reason) => ffmpegControl('resume', { operationId, reason, reconciled: true }),
    };
  return {
    kind: 'resume',
    title: 'Продолжить: открыть приём и запустить worker',
    confirmLabel: 'Продолжить',
    right: 'operate',
    effect: (
      <>
        <p style={{ margin: '0 0 8px' }}>Worker снова берёт задачи из очереди ({queued}), приём новых задач открывается.</p>
        {ready && !ready.ready && (
          <p className="critical" style={{ margin: 0 }}>
            Сейчас сервер не готов: {ready.reason ?? 'причина не сообщена'}. Продолжение будет отклонено, пока readiness не пройдёт.
          </p>
        )}
        {!ready && <p className="muted" style={{ margin: 0 }}>Готовность сервера сейчас неизвестна — сервер проверит её сам.</p>}
      </>
    ),
    run: (operationId, reason) => ffmpegControl('resume', { operationId, reason }),
  };
}

function jobSpec(action: 'reconcile' | 'cancel' | 'purge', job: FfmpegJobDetail): ActionSpec {
  const target = (
    <>
      Задача <code>{job.id}</code> · {STATE_LABEL[job.state]}
      {job.operationId ? (
        <>
          {' '}
          · операция <code>{job.operationId}</code>
        </>
      ) : null}
    </>
  );
  if (action === 'reconcile')
    return {
      kind: 'reconcile',
      title: 'Сверить задачу',
      confirmLabel: 'Сверить',
      right: 'operate',
      target,
      effect: (
        <p style={{ margin: 0 }}>
          Только чтение: статус задачи запрашивается у провайдера, к которому она ушла (по id и ключу). Ничего не рендерится, задача не
          отправляется в hosted, состояние «исход неизвестен» не переводится обратно в очередь. Истёкшие ссылки — не повод создавать задачу.
        </p>
      ),
      reason: 'optional',
      run: (operationId, reason) => reconcileFfmpegJob(job.id, { operationId, ...(reason ? { reason } : {}) }),
    };
  if (action === 'cancel')
    return {
      kind: 'cancel',
      title: 'Отменить задачу',
      confirmLabel: 'Отменить задачу',
      right: 'operate',
      danger: true,
      target,
      effect: (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>Отменяется только эта задача. Если FFmpeg уже работает, он будет остановлен вместе со всей группой процессов.</li>
          <li>Если задача успеет завершиться раньше отмены, она останется выполненной — гонку решает сервер.</li>
          <li>Отмена не возвращает деньги и не удаляет принятую версию в продукте.</li>
        </ul>
      ),
      checks: ['Понимаю: продукт получит отмену этой обработки и должен будет запускать новую версию сам'],
      run: (operationId, reason) => cancelFfmpegJob(job.id, { operationId, reason }),
    };
  const names = job.outputs.map((o) => o.name);
  return {
    kind: 'purge',
    title: 'Удалить временные файлы задачи',
    confirmLabel: 'Удалить файлы',
    right: 'operate',
    danger: true,
    target,
    effect: (
      <>
        <p style={{ margin: '0 0 6px' }}>Будут удалены на FFmpeg-сервере:</p>
        <ul style={{ margin: '0 0 8px', paddingLeft: 20 }}>
          {names.length ? names.map((n) => <li key={n}><code>{n}</code></li>) : <li>результатов нет — удаляются входы и рабочая папка</li>}
          <li>скачанные входы и промежуточные файлы задачи</li>
        </ul>
        <p style={{ margin: '0 0 6px' }}>
          Выданные ссылки отзываются сразу; если задача ещё выполняется, она будет остановлена. Завершение удаления показывается в карточке
          отдельно. Запись задачи, факт выполнения и журнал сохраняются.
        </p>
        <p style={{ margin: 0 }}>Не затрагиваются: Blob и готовые сборки продукта, принятый Tutorial, эталоны.</p>
      </>
    ),
    checks: ['Понимаю: удаление необратимо, восстановить эти файлы будет нельзя'],
    run: (operationId, reason) => purgeFfmpegJob(job.id, { operationId, reason, confirmIrreversible: true }),
  };
}

function FfmpegPageInner() {
  const { me } = useAdminAuth();
  const params = useSearchParams();
  const router = useRouter();
  const filters = useMemo(() => parseFilters(params), [params]);
  const filtersKey = filtersToSearch(filters);
  const openJob = cleanJobId(params.get('job'));

  const go = useCallback(
    (f: FfmpegFilters, job: string | null) => router.push(`/ffmpeg${filtersToSearch(f, job)}`, { scroll: false }),
    [router],
  );

  // Курсоры страниц: сброс при смене фильтров (производно, без лишнего запроса).
  const [pager, setPager] = useState<{ key: string; stack: string[] }>({ key: filtersKey, stack: [''] });
  const stack = pager.key === filtersKey ? pager.stack : [''];
  const cursor = stack[stack.length - 1];

  const enabled = !!me;
  const overview = usePoll(enabled ? 'overview' : null, getFfmpegOverview, (d) => d.stale);
  const jobs = usePoll(
    enabled ? `jobs${filtersKey}#${cursor}` : null,
    (signal) => listFfmpegJobs(filtersToQuery(filters, cursor || null), signal),
    (d) => d.stale,
  );
  const job = usePoll(enabled && openJob ? `job:${openJob}` : null, (signal) => getFfmpegJob(openJob, signal), (d) => d.stale);
  const limits = usePoll(enabled ? 'limits' : null, getFfmpegLimits, (d) => d.stale);

  // «Сейчас» для свежести значений — тикает, пока вкладка видна.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    }, 5_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setNow(Date.now());
  }, [overview.okAt, jobs.okAt, job.okAt, limits.okAt]);

  const { refresh: refreshOverview } = overview;
  const { refresh: refreshJobs } = jobs;
  const { refresh: refreshJob } = job;
  const { refresh: refreshLimits } = limits;
  const refreshAll = useCallback(() => {
    refreshOverview();
    refreshJobs();
    refreshJob();
    refreshLimits();
  }, [refreshOverview, refreshJobs, refreshJob, refreshLimits]);

  const [dialog, setDialog] = useState<ActionSpec | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'warning' } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  const openDialog = (spec: ActionSpec) => {
    opener.current = document.activeElement as HTMLElement | null;
    setNotice(null);
    setDialog(spec);
  };
  const closeDialog = (message?: { text: string; tone: 'ok' | 'warning' }) => {
    setDialog(null);
    if (message) setNotice(message);
    const back = opener.current;
    opener.current = null;
    setTimeout(() => {
      if (message) noticeRef.current?.focus();
      else if (back?.isConnected && !(back as HTMLButtonElement).disabled) back.focus();
    }, 0);
  };

  const onLimits = (changes: LimitChange[], baseRevision: number) =>
    openDialog({
      kind: 'limits',
      title: 'Изменить лимиты',
      confirmLabel: 'Применить лимиты',
      right: 'configure',
      target: <>Ревизия {baseRevision} → новая</>,
      effect: limitsEffect(changes),
      run: (operationId, reason) =>
        setFfmpegLimits({
          operationId,
          reason,
          expectedRevision: baseRevision,
          limits: Object.fromEntries(changes.map((c) => [c.key, c.to])),
        }),
    });

  const onRouting = (change: RoutingChange, next: { provider: FfmpegProvider; canary: FfmpegProduct[] }, base: FfmpegRouting) =>
    openDialog({
      kind: 'routing',
      title: change.toSelfhostedDefault ? 'Перевести новые задачи на selfhosted по умолчанию' : 'Изменить маршрутизацию новых задач',
      confirmLabel: change.toSelfhostedDefault ? 'Перевести default на selfhosted' : 'Применить маршрутизацию',
      right: 'configure',
      danger: change.toSelfhostedDefault,
      target: <>Ревизия маршрутизации {base.revision}</>,
      effect: routingEffect(change, base.selfhostedEnabled),
      checks: change.toSelfhostedDefault
        ? ['Я владелец; критерии приёмки canary пройдены (24 ч canary, нагрузка, relay, очистка, rollback проверен)']
        : undefined,
      typed: change.toSelfhostedDefault ? { word: 'selfhosted', label: 'Отдельное подтверждение: введите слово selfhosted' } : undefined,
      run: (operationId, reason) =>
        setFfmpegRouting({
          operationId,
          reason,
          expectedRevision: base.revision ?? 0,
          defaultProvider: next.provider,
          canaryProducts: next.canary,
          ...(change.toSelfhostedDefault ? { confirmSelfhostedDefault: true } : {}),
        }),
    });

  if (!me) {
    return (
      <main className="page">
        <p className="muted">Проверяем вход…</p>
      </main>
    );
  }

  const lastOk = [overview.okAt, jobs.okAt, limits.okAt].filter((x): x is number => x !== null);
  const anyLoading = overview.loading || jobs.loading || limits.loading || job.loading;
  const backoff = Math.max(overview.failures, jobs.failures, limits.failures, job.failures);

  return (
    <main className="page" style={{ maxWidth: 1200 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>FFmpeg: обработка</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13, maxWidth: 720 }}>
            Очередь и задачи собственного FFmpeg-сервера и hosted-провайдера. Данные приходят через backend; ключ сервера и исходные ссылки
            входов здесь не показываются. Повторного рендера нет — новая версия создаётся только из операции продукта.
          </p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span className="muted" aria-live="polite" style={{ fontSize: 12 }}>
            {anyLoading
              ? 'Обновляем…'
              : lastOk.length
                ? `Обновлено в ${kyivTime(new Date(Math.max(...lastOk)).toISOString())}`
                : ''}
            {backoff > 0 ? ' · ошибки связи — опрос реже' : ` · авто каждые ${FFMPEG_REFRESH_MS / 1000} с`}
          </span>
          <button type="button" onClick={refreshAll} disabled={anyLoading}>
            Обновить
          </button>
        </div>
      </div>

      <div
        ref={noticeRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className={notice ? `rx-alert ${notice.tone === 'ok' ? 'rx-alert-success' : 'rx-alert-warning'}` : undefined}
        style={notice ? { marginBottom: 12 } : { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}
      >
        {notice?.text ?? ''}
      </div>

      <OverviewPanel
        overview={overview.data}
        error={overview.error}
        okAt={overview.okAt}
        now={now}
        busy={!!dialog}
        onAction={(a) => openDialog(controlSpec(a, overview.data))}
        onOpenJob={(id) => go(filters, id)}
      />

      {openJob && (
        <JobCard
          jobId={openJob}
          job={job.data}
          error={job.error}
          loading={job.loading}
          busy={!!dialog}
          onClose={() => go(filters, null)}
          onAction={(a, j) => openDialog(jobSpec(a, j))}
        />
      )}

      <JobsPanel
        filters={filters}
        page={jobs.data}
        error={jobs.error}
        okAt={jobs.okAt}
        loading={jobs.loading}
        pageIndex={stack.length - 1}
        openJob={openJob}
        onFilters={(f) => go(f, null)}
        onOpen={(id) => go(filters, id)}
        onFirst={() => setPager({ key: filtersKey, stack: [''] })}
        onPrev={() => setPager({ key: filtersKey, stack: stack.length > 1 ? stack.slice(0, -1) : [''] })}
        onNext={() => jobs.data?.nextCursor && setPager({ key: filtersKey, stack: [...stack, jobs.data.nextCursor] })}
      />

      <LimitsPanel view={limits.data} error={limits.error} busy={!!dialog} onLimits={onLimits} onRouting={onRouting} />

      {dialog && (
        <ActionDialog
          key={dialog.kind}
          spec={dialog}
          onDone={(text) => {
            closeDialog({ text, tone: 'ok' });
            refreshAll();
          }}
          onClose={(unknownNote) => {
            closeDialog(unknownNote ? { text: unknownNote, tone: 'warning' } : undefined);
            if (unknownNote) refreshAll();
          }}
          onStale={refreshAll}
        />
      )}
    </main>
  );
}
