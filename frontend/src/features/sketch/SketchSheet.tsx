/**
 * SketchSheet — окно генерации скетча (doc/AI-SKETCH-SPEC.md §3.2): на
 * телефоне нижний лист, на десктопе модалка (та же раскладка, что у
 * `ConfirmDialog`: `items-end sm:items-center`).
 *
 * Почему кандидаты живут лентой, а не заменяют друг друга: «Ещё вариант»
 * — это повторная ОПЛАЧЕННАЯ генерация (§8.2), и если второй вариант
 * вышел хуже первого, вернуться к первому нужно без третьей попытки.
 * По той же причине лента перечитывается при открытии: кандидаты живут
 * до TTL (§6.7), и «Отмена» не должна выглядеть как потеря варианта, за
 * который квота уже списана.
 *
 * Сама форма и превью — в `SketchControls.tsx`, здесь только состояние,
 * запросы и разбор отказов.
 */

import { useEffect, useState } from 'react';
import { PenTool, X } from 'lucide-react';
import { Alert, Button, Card, Spinner } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { navigate, routes } from '../../lib/router';
import { errorMessage, isUnauthorized } from '../../services/projects-api';
import {
  applySketch,
  generateSketch,
  getSketchQuota,
  isSketchRefused,
  listSketches,
  sketchConflict,
  sketchQuotaRefusal,
  type SketchQuotaRefusal,
} from '../../services/sketch-api';
import type {
  SketchMode,
  SketchOptions,
  SketchQuota,
  SketchSlotView,
  SketchStyle,
  SketchTarget,
  SketchView,
} from '../../types/sketch';
import { SketchForm, SketchPreview } from './SketchControls';
import {
  availableModes,
  canGenerate,
  DEFAULT_SKETCH_STYLE,
  defaultMode,
  defaultSketchOptions,
  quotaLine,
  quotaState,
} from './sketch-model';

export function SketchSheet({
  target,
  hasImage,
  originalUrl,
  description,
  onClose,
  onApplied,
}: {
  target: SketchTarget;
  hasImage: boolean;
  /** Левая половина превью «оригинал / скетч»; null — сравнивать не с чем. */
  originalUrl?: string | null;
  description?: string;
  onClose: () => void;
  onApplied: (slot: SketchSlotView) => void;
}) {
  const { dict } = useI18n();
  const t = dict.sketch;
  const modes = availableModes(hasImage);

  const [mode, setMode] = useState<SketchMode>(defaultMode(hasImage));
  const [style, setStyle] = useState<SketchStyle>(DEFAULT_SKETCH_STYLE);
  const [options, setOptions] = useState<SketchOptions>(() =>
    defaultSketchOptions(target.type)
  );
  const [text, setText] = useState(description ?? '');
  const [candidates, setCandidates] = useState<SketchView[]>([]);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [quota, setQuota] = useState<SketchQuota | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<SketchQuotaRefusal | null>(null);
  // На узком экране оригинал и скетч рядом не помещаются — там переключатель.
  const [compare, setCompare] = useState<'original' | 'sketch'>('sketch');

  const chosen = candidates.find((c) => c.id === chosenId) ?? null;
  const locked = busy || applying;

  /**
   * Отказы разбираются здесь, а не общим `errorMessage()`: у скетча три
   * случая со своим текстом (§3.2, п. 6) и один — с CTA тарифа (§8.4),
   * и все четыре сервер отдаёт обычным HTTP-кодом.
   */
  /** Перечитать остаток — после оплаченной, но неудачной попытки. */
  const refreshQuota = () => {
    void getSketchQuota()
      .then(setQuota)
      .catch(() => undefined);
  };

  const fail = (e: unknown) => {
    const over = sketchQuotaRefusal(e);
    if (over) {
      setRefusal(over);
      if (over.quota) setQuota(over.quota);
      return;
    }
    if (isSketchRefused(e)) {
      // Отказ модели по безопасности ОПЛАЧЕН (§8.2): счётчик обязан
      // сдвинуться, иначе экран обещает попытку, которой уже нет
      // (аудит A-15).
      refreshQuota();
      return setError(t.errSafety);
    }
    const conflict = sketchConflict(e);
    if (conflict === 'already-applied') return setError(t.errAlreadyApplied);
    if (conflict === 'sketch-gone') return setError(t.errSketchGone);
    if (conflict === 'source-changed') return setError(t.errStale);
    if (isUnauthorized(e)) return setError(t.guestOnly);
    setError(errorMessage(e, t.errFailed, dict.errors));
  };

  useEffect(() => {
    let alive = true;
    listSketches(target)
      .then((d) => {
        if (!alive) return;
        const usable = d.items.filter((i) => i.url);
        setCandidates(usable);
        setChosenId(d.active?.id ?? usable[usable.length - 1]?.id ?? null);
        setQuota(d.quota);
      })
      .catch((e) => {
        if (alive) fail(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // Цель окна не меняется, пока оно открыто.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked, onClose]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const res = await generateSketch({
        target,
        mode,
        style,
        options,
        description: mode === 'from-text' ? text.trim() : undefined,
      });
      // Отказ модели приходит отдельным кодом 422 (его разбирает
      // `fail`), поэтому здесь результат всегда с файлом — ветка «200 с
      // пустым url» была недостижима (аудит A-15).
      setQuota(res.quota);
      setCandidates((prev) => [...prev, res.sketch]);
      setChosenId(res.sketch.id);
      setCompare('sketch');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!chosen) return;
    setApplying(true);
    setError(null);
    try {
      onApplied(await applySketch(chosen.id, options.sketchRendering));
    } catch (e) {
      fail(e);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm animate-fadeIn sm:items-center sm:p-4"
      onClick={() => !locked && onClose()}
    >
      <Card
        role="dialog"
        aria-modal="true"
        aria-label={t.title}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-b-none p-5 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start gap-2">
          <PenTool size={18} className="mt-0.5 shrink-0 text-accent" />
          <h2 className="min-w-0 flex-1 text-lg font-bold tracking-tight">
            {t.title}
          </h2>
          <button
            type="button"
            aria-label={dict.common.close}
            onClick={onClose}
            disabled={locked}
            className="shrink-0 rounded-lg p-1.5 text-silver-400 hover:text-accent disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-6">
            <Spinner size={20} />
          </div>
        ) : (
          <div className="space-y-4">
            <SketchForm
              targetType={target.type}
              modes={modes}
              mode={mode}
              style={style}
              options={options}
              description={text}
              disabled={locked}
              onMode={setMode}
              onStyle={setStyle}
              onOptions={setOptions}
              onDescription={setText}
            />

            {busy && (
              <div className="flex items-center gap-3 rounded-xl border border-silver-200/70 p-3 dark:border-silver-800">
                <Spinner size={18} />
                <div className="min-w-0 text-xs">
                  <div className="font-medium">{t.busy}</div>
                  <div className="text-silver-400">{t.busyHint}</div>
                </div>
              </div>
            )}

            {chosen?.url && (
              <SketchPreview
                originalUrl={originalUrl ?? null}
                sketchUrl={chosen.url}
                compare={compare}
                onCompare={setCompare}
              />
            )}

            {candidates.length > 1 && (
              <ul className="flex gap-2 overflow-x-auto pb-1">
                {candidates.map((c, i) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-label={t.candidateAria.replace(
                        '{{n}}',
                        String(i + 1)
                      )}
                      aria-pressed={c.id === chosenId}
                      onClick={() => setChosenId(c.id)}
                      className={`h-14 w-14 overflow-hidden rounded-lg border transition-all ${
                        c.id === chosenId
                          ? 'border-accent ring-2 ring-accent/40'
                          : 'border-silver-200/70 dark:border-silver-800'
                      }`}
                    >
                      {c.url && (
                        <img
                          src={c.url}
                          alt=""
                          data-qa-mask="sketch-candidate"
                          className="h-full w-full object-cover"
                        />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {quota && !refusal && (
              <p className="text-xs text-silver-500">
                {quotaLine(quota, t.quotaLine)}
              </p>
            )}

            {refusal && (
              <Alert tone="warning">
                {quotaState(refusal.quota) === 'month-over'
                  ? t.quotaMonthOver
                  : t.quotaDayOver}
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => navigate(routes.plan())}
                >
                  {t.upgradeCta}
                </Button>
              </Alert>
            )}

            {error && (
              <Alert tone="error" onDismiss={() => setError(null)}>
                {error}
              </Alert>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                loading={busy}
                disabled={applying || !canGenerate(mode, text)}
                onClick={() => void generate()}
              >
                {candidates.length > 0 ? t.another : t.generate}
              </Button>
              {chosen?.url && (
                <Button
                  size="sm"
                  variant="outline"
                  loading={applying}
                  disabled={busy}
                  onClick={() => void apply()}
                >
                  {t.apply}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={locked}
                onClick={onClose}
              >
                {t.cancel}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
