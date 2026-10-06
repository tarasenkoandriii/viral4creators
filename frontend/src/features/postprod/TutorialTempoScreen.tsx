/**
 * TutorialTempoScreen (#/postprod/tutorial/:assetId) — темп обучалки по
 * сайту в «Постпроде» (doc/TUTORIAL-POSTPROD-TEMPO-SPEC.md, 06.10.2026).
 *
 * Обучалка — не сессия генерации, поэтому свой экран и свой маршрут, а
 * не `PostprodVideoScreen` с подменённым `sessionId`.
 *
 * Поведение по спецификации: три пресета и ползунок точной настройки,
 * подпись «меняет паузы; скорость речи сохраняется», итоговая
 * длительность и предупреждение о достигнутом минимуме. Расчёт и
 * предпросмотр бесплатные (сервер считает по монтажному плану, браузер
 * проигрывает кадры и реплики), «Сохранить» — одна платная сборка
 * версии; исходный ролик остаётся, «Вернуть обычный темп» — без сборки.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Gauge, RotateCcw, Save } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Spinner,
} from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { routes } from '../../lib/router';
import { ScreenHeader } from '../projects/shared';
import { errorMessage } from '../../services/projects-api';
import {
  activateTutorialVersion,
  getTutorialTempo,
  listTutorialVersions,
  requestTutorialVersion,
  revertTutorialTempo,
  type TutorialTempoEstimate,
  type TutorialVersionView,
} from '../../services/tutorial-videos-api';
import {
  durationChangePercent,
  formatDuration,
  presetOf,
  snapFactor,
  TEMPO_MAX,
  TEMPO_MIN,
  TEMPO_PRESET_ORDER,
  TEMPO_PRESETS,
  TEMPO_STEP,
  type TempoUnavailableReason,
  type TempoWarning,
} from '../../lib/tutorial-tempo';
import { TutorialPreview } from './TutorialPreview';

/** Расчёт бесплатный, но не на каждый пиксель ползунка. */
const ESTIMATE_DEBOUNCE_MS = 250;
/** Опрос собирающейся версии — тот же темп, что у списка роликов. */
const VERSION_POLL_MS = 4000;

type Dict = ReturnType<typeof useI18n>['dict'];

function fill(s: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.split(`{{${k}}}`).join(String(v)),
    s
  );
}

function reasonText(t: Dict['tutorialTempo'], r: TempoUnavailableReason) {
  switch (r) {
    case 'whole-track':
      return t.reasonWholeTrack;
    case 'sources-pending':
      return t.reasonSourcesPending;
    case 'not-complete':
      return t.reasonNotComplete;
    case 'frames-purged':
      return t.reasonFramesPurged;
    default:
      return t.reasonNoManifest;
  }
}

function warningText(t: Dict['tutorialTempo'], w: TempoWarning): string {
  switch (w.code) {
    case 'pauses-at-minimum':
      return fill(t.warnPausesAtMinimum, { n: w.frames });
    case 'source-frame-too-short':
      return fill(t.warnSourceTooShort, { n: w.frameIndexes.length });
    case 'speech-unmeasured':
      return fill(t.warnSpeechUnmeasured, { n: w.frameIndexes.length });
    case 'zoom-dropped':
      return t.warnZoomDropped;
  }
}

function presetLabel(t: Dict['tutorialTempo'], p: keyof typeof TEMPO_PRESETS) {
  return p === 'calm'
    ? t.presetCalm
    : p === 'fast'
      ? t.presetFast
      : t.presetNormal;
}

export function TutorialTempoScreen({ assetId }: { assetId: string }) {
  const { dict } = useI18n();
  const t = dict.tutorialTempo;
  const [factor, setFactor] = useState<number | null>(null);
  const [estimate, setEstimate] = useState<TutorialTempoEstimate | null>(null);
  const [versions, setVersions] = useState<TutorialVersionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'success' | 'warning';
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState<string | null>(null);
  const seq = useRef(0);

  const refreshVersions = useCallback(async () => {
    try {
      setVersions(await listTutorialVersions(assetId));
    } catch {
      /* необязательный список — экран темпа работает и без него */
    }
  }, [assetId]);

  // Первый заход: темп, который действует сейчас, — от него и считаем.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const first = await getTutorialTempo(assetId, 1);
        if (cancelled) return;
        setEstimate(first);
        setFactor(first.activeFactor);
        if (first.inFlight) setWatching(first.inFlight.id);
        await refreshVersions();
      } catch (e) {
        if (cancelled) return;
        const status = (e as { response?: { status?: number } })?.response
          ?.status;
        if (status === 404) setNotFound(true);
        else setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId, refreshVersions]);

  // Пересчёт при смене темпа — бесплатный запрос, с задержкой.
  useEffect(() => {
    if (factor === null) return;
    const my = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const next = await getTutorialTempo(assetId, factor);
        if (my === seq.current) setEstimate(next);
      } catch (e) {
        if (my === seq.current) setError(errorMessage(e));
      }
    }, ESTIMATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [assetId, factor]);

  // Опрос собирающейся версии: готова — сообщение и свежий расчёт.
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const list = await listTutorialVersions(assetId);
        setVersions(list);
        const v = list.find((x) => x.id === watching);
        if (!v || v.status === 'pending' || v.status === 'preparing') return;
        setWatching(null);
        setNotice(
          v.status === 'complete'
            ? { tone: 'success', text: t.saved }
            : { tone: 'warning', text: t.failed }
        );
        const fresh = await getTutorialTempo(assetId, factor ?? 1);
        setEstimate(fresh);
      } catch {
        /* следующий тик попробует снова */
      }
    }, VERSION_POLL_MS);
    return () => clearInterval(timer);
  }, [assetId, watching, factor, t.saved, t.failed]);

  const save = async () => {
    if (factor === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await requestTutorialVersion(assetId, factor);
      const v = res.version;
      if (v.status === 'complete') {
        setNotice({
          tone: 'success',
          text: factor === 1 ? t.reverted : t.saved,
        });
        setEstimate(await getTutorialTempo(assetId, factor));
      } else if (v.status === 'failed') {
        setNotice({ tone: 'warning', text: t.failed });
      } else {
        setWatching(v.id);
      }
      await refreshVersions();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    setBusy(true);
    setError(null);
    try {
      await revertTutorialTempo(assetId);
      setFactor(1);
      setNotice({ tone: 'success', text: t.reverted });
      setEstimate(await getTutorialTempo(assetId, 1));
      await refreshVersions();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const makeActive = async (versionId: string) => {
    setBusy(true);
    setError(null);
    try {
      const v = await activateTutorialVersion(assetId, versionId);
      setFactor(v.factor);
      setNotice({ tone: 'success', text: t.saved });
      setEstimate(await getTutorialTempo(assetId, v.factor));
      await refreshVersions();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size={26} />
      </div>
    );
  }
  if (notFound || !estimate) {
    return (
      <div className="animate-fadeIn">
        <ScreenHeader title={t.title} back={routes.postprod()} />
        {error ? (
          <Alert tone="error">{error}</Alert>
        ) : (
          <EmptyState
            icon={<Gauge size={28} />}
            title={t.notFoundTitle}
            hint={t.notFoundHint}
          />
        )}
      </div>
    );
  }

  const change = durationChangePercent(
    estimate.durationMs,
    estimate.sourceDurationMs
  );
  const building = !!watching || !!estimate.inFlight;
  const selected = factor ?? estimate.activeFactor;
  const sameAsActive = selected === estimate.activeFactor;

  return (
    <div className="animate-fadeIn space-y-4">
      <ScreenHeader
        title={estimate.title || t.title}
        back={routes.postprod()}
        hint={t.hint}
      />

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      {estimate.url && (
        <Card className="p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <strong className="text-sm">{t.currentVideo}</strong>
            <Badge tone={estimate.activeFactor === 1 ? 'neutral' : 'accent'}>
              {fill(t.activeLabel, { factor: estimate.activeFactor })}
            </Badge>
          </div>
          <video
            src={estimate.url}
            controls
            playsInline
            preload="metadata"
            className="mx-auto max-h-[360px] rounded-lg bg-black"
            data-qa-mask="tutorial-video"
          />
          <p className="text-xs text-[var(--muted)] tabular">
            {formatDuration(estimate.currentDurationMs)}
          </p>
        </Card>
      )}

      {!estimate.editable && estimate.reason && (
        <Alert tone="info">{reasonText(t, estimate.reason)}</Alert>
      )}

      {estimate.editable && (
        <Card className="p-4 space-y-4">
          <div>
            <h3 className="font-semibold">{t.title}</h3>
            <p className="mt-1 text-xs text-[var(--muted)]">{t.hint}</p>
          </div>

          <div className="grid grid-cols-3 gap-2" role="radiogroup">
            {TEMPO_PRESET_ORDER.map((p) => (
              <Button
                key={p}
                size="sm"
                variant={presetOf(selected) === p ? 'solid' : 'outline'}
                aria-pressed={presetOf(selected) === p}
                disabled={busy}
                onClick={() => setFactor(TEMPO_PRESETS[p])}
              >
                {presetLabel(t, p)}
              </Button>
            ))}
          </div>

          <label className="block text-xs text-[var(--muted)]">
            {fill(t.sliderLabel, { factor: selected.toFixed(2) })}
            <input
              type="range"
              min={TEMPO_MIN}
              max={TEMPO_MAX}
              step={TEMPO_STEP}
              value={selected}
              disabled={busy}
              onChange={(e) => setFactor(snapFactor(Number(e.target.value)))}
              className="mt-1 w-full accent-[var(--accent)]"
            />
          </label>

          <div className="text-sm">
            <strong className="tabular">
              {fill(t.duration, {
                duration: formatDuration(estimate.durationMs),
              })}
            </strong>
            {change !== null && change !== 0 && (
              <span className="ml-1 text-[var(--muted)]">
                (
                {fill(change < 0 ? t.changeShorter : t.changeLonger, {
                  n: Math.abs(change),
                })}
                )
              </span>
            )}
            <p className="text-xs text-[var(--muted)] tabular">
              {fill(t.durationSource, {
                duration: formatDuration(estimate.sourceDurationMs),
              })}
              {' · '}
              {fill(t.durationMin, {
                duration: formatDuration(estimate.minimumDurationMs),
              })}
            </p>
          </div>

          {!estimate.voiced && <Alert tone="info">{t.noVoice}</Alert>}
          {estimate.warnings.map((w, i) => (
            <Alert key={`${w.code}-${i}`} tone="warning">
              {warningText(t, w)}
            </Alert>
          ))}

          {estimate.preview && (
            <div className="space-y-1">
              <strong className="text-sm">{t.previewTitle}</strong>
              <TutorialPreview
                preview={estimate.preview}
                labels={{
                  play: t.previewPlay,
                  stop: t.previewStop,
                  audioFallback: t.previewAudioFallback,
                }}
              />
              <p className="text-xs text-[var(--muted)]">{t.previewHint}</p>
            </div>
          )}

          {building ? (
            <Alert tone="info">{t.saving}</Alert>
          ) : (
            <div className="space-y-2">
              <Button
                block
                icon={<Save size={16} />}
                loading={busy}
                disabled={busy || sameAsActive}
                onClick={() => void save()}
              >
                {t.save}
              </Button>
              <p className="text-xs text-[var(--muted)]">
                {sameAsActive ? t.sameAsActive : t.saveHint}
              </p>
            </div>
          )}

          {estimate.activeFactor !== 1 && !building && (
            <Button
              block
              variant="ghost"
              icon={<RotateCcw size={14} />}
              disabled={busy}
              onClick={() => void revert()}
            >
              {t.revert}
            </Button>
          )}
        </Card>
      )}

      {versions.length > 0 && (
        <Card className="p-4 space-y-2">
          <strong className="text-sm">{t.versionsTitle}</strong>
          <ul className="space-y-1.5">
            {versions.map((v) => (
              <li
                key={v.id}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="tabular">
                  {v.kind === 'source' ? t.versionSource : `×${v.factor}`}
                  {' · '}
                  {formatDuration(v.durationMs)}
                </span>
                {v.active ? (
                  <Badge tone="success">{t.versionActive}</Badge>
                ) : v.status === 'failed' ? (
                  <Badge tone="danger">{t.versionFailed}</Badge>
                ) : v.status !== 'complete' ? (
                  <Badge tone="warning">{t.versionBuilding}</Badge>
                ) : v.requiresApproval ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void makeActive(v.id)}
                  >
                    {t.versionMakeActive}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
