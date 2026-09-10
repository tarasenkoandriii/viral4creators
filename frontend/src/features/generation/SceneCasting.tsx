/**
 * SceneCasting — тот же механизм, что у «Персонажей референса», но для
 * СЦЕН и МАССОВКИ (spec §19, этап 24):
 *  - чип = фильтр: клик подсвечивает в разборе строки про эту сцену
 *    (по таймкоду и заголовку) или про эту группу массовки;
 *  - крестик на чипе = снять: сцена не воспроизводится в новом ролике
 *    (её время перераспределяется), массовка убирается из кадра;
 *  - выбор хранится на сервере (`analysisSelection`) и уходит в бриф GPT
 *    секциями SCENES TO DROP / EXTRAS.
 *
 * Массовка намеренно без кастинга: у неё нет замены фотографией — это фон,
 * его либо оставляют, либо убирают.
 */

import { useEffect, useState } from 'react';
import { Clapperboard, Film, UsersRound, X } from 'lucide-react';
import { Alert, Badge, Card, CardHeader, Spinner } from '../../components/ui';
import {
  errorMessage,
  getAnalysisSelection,
  putAnalysisSelection,
} from '../../services/projects-api';
import { formatTime } from '../../lib/audience';
import { timecodeTerms } from '../../lib/highlight';
import type { AnalysisSelectionView, VideoAnalysis } from '../../types';
import { useI18n } from '../../lib/i18n-context';

/** Что подсвечивать в разборе, когда выбран чип. */
export interface HighlightFocus {
  kind: 'character' | 'scene' | 'extra';
  id: string;
  label: string;
  terms: string[];
  exact: string[];
}

export function SceneCasting({
  sessionId,
  analysis,
  focus,
  onFocus,
  previewsStatus,
}: {
  sessionId: string;
  analysis: Pick<VideoAnalysis, 'scenes' | 'extras'>;
  focus: HighlightFocus | null;
  onFocus: (focus: HighlightFocus | null) => void;
  previewsStatus?: 'idle' | 'capturing' | 'done' | 'unavailable';
}) {
  const { dict } = useI18n();
  const [view, setView] = useState<AnalysisSelectionView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getAnalysisSelection(sessionId)
      .then((v) => alive && setView(v))
      .catch((e) => {
        if (!alive) return;
        setError(errorMessage(e));
        setView({ scenes: [], extras: [], updatedAt: null });
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const persist = async (droppedScenes: string[], droppedExtras: string[]) => {
    setSaving(true);
    setError(null);
    try {
      setView(
        await putAnalysisSelection(sessionId, { droppedScenes, droppedExtras })
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (!view) {
    return (
      <Card className="p-5">
        <div className="flex justify-center py-3">
          <Spinner size={20} />
        </div>
      </Card>
    );
  }

  // `?? []` — ответ сервера мог прийти без массива (старая сессия,
  // частичный ответ): одно `undefined.length` здесь гасило всё приложение
  // до появления границы ошибок (этап 48, В-5.3).
  const scenes = view.scenes ?? [];
  const extras = view.extras ?? [];
  if (scenes.length === 0 && extras.length === 0) return null;

  const droppedScenes = scenes.filter((s) => !s.active).map((s) => s.id);
  const droppedExtras = extras.filter((e) => !e.active).map((e) => e.id);
  const keptScenes = scenes.length - droppedScenes.length;

  const toggleScene = (id: string) => {
    const next = droppedScenes.includes(id)
      ? droppedScenes.filter((x) => x !== id)
      : [...droppedScenes, id];
    if (next.length === scenes.length) {
      setError(dict.sceneCasting.cantDropAll);
      return;
    }
    void persist(next, droppedExtras);
  };

  const toggleExtra = (id: string) =>
    void persist(
      droppedScenes,
      droppedExtras.includes(id)
        ? droppedExtras.filter((x) => x !== id)
        : [...droppedExtras, id]
    );

  const sceneOf = (id: string) => scenes.find((s) => s.id === id);
  const focusScene = (id: string) => {
    const s = sceneOf(id);
    if (!s) return;
    onFocus(
      focus?.kind === 'scene' && focus.id === id
        ? null
        : {
            kind: 'scene',
            id,
            label: s.title,
            terms: [s.title],
            exact: timecodeTerms(s.start, s.end),
          }
    );
  };
  const focusExtra = (id: string) => {
    const e = extras.find((x) => x.id === id);
    if (!e) return;
    onFocus(
      focus?.kind === 'extra' && focus.id === id
        ? null
        : {
            kind: 'extra',
            id,
            label: e.label,
            terms: [e.label, e.description],
            exact: [],
          }
    );
  };

  const previewOf = (id: string, kind: 'scene' | 'extra') => {
    const src =
      kind === 'scene'
        ? analysis.scenes?.find((s) => s.id === id)?.previewUrl
        : analysis.extras?.find((e) => e.id === id)?.previewUrl;
    return src ?? null;
  };

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Clapperboard size={18} className="text-accent" />}
        title={dict.sceneCasting.title}
        hint={dict.sceneCasting.hint
          .replace('{{kept}}', String(keptScenes))
          .replace('{{total}}', String(scenes.length))}
        action={saving ? <Spinner size={16} /> : undefined}
      />

      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {scenes.length > 0 && (
        <>
          <span className="label">{dict.sceneCasting.scenesLabel}</span>
          <ul className="mb-4 space-y-2">
            {scenes.map((s, i) => {
              const focused = focus?.kind === 'scene' && focus.id === s.id;
              const preview = previewOf(s.id, 'scene');
              return (
                <li
                  key={s.id}
                  className={`flex items-center gap-3 rounded-xl border px-2.5 py-2 transition-colors ${
                    s.active
                      ? focused
                        ? 'border-accent bg-accent/5 ring-1 ring-accent/40'
                        : 'border-silver-200/70 dark:border-silver-800'
                      : 'border-dashed border-silver-300 opacity-60 dark:border-silver-700'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => focusScene(s.id)}
                    disabled={saving}
                    aria-pressed={focused}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className="relative h-11 w-16 shrink-0 overflow-hidden rounded-lg bg-silver-200/60 dark:bg-silver-800/60">
                      {preview ? (
                        <img
                          src={preview}
                          alt=""
                          className={`h-full w-full object-cover ${s.active ? '' : 'grayscale'}`}
                        />
                      ) : (
                        <span className="grid h-full place-items-center text-silver-400">
                          {previewsStatus === 'capturing' ? (
                            <Spinner size={12} />
                          ) : (
                            <Film size={14} />
                          )}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[11px] text-silver-400 tabular">
                          {formatTime(s.start)}–{formatTime(s.end)}
                        </span>
                        {!s.active && (
                          <Badge tone="danger">
                            {dict.sceneCasting.droppedBadge}
                          </Badge>
                        )}
                      </span>
                      <span
                        className={`mt-0.5 block truncate text-xs font-medium ${s.active ? '' : 'line-through decoration-silver-400/60'}`}
                      >
                        {s.title ||
                          dict.sceneCasting.sceneFallback.replace(
                            '{{n}}',
                            String(i + 1)
                          )}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={
                      s.active
                        ? dict.sceneCasting.dropScene
                        : dict.sceneCasting.restoreScene
                    }
                    onClick={() => toggleScene(s.id)}
                    disabled={saving}
                    className={`inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg p-1.5 disabled:opacity-50 ${
                      s.active
                        ? 'text-silver-400 hover:bg-rose-500/10 hover:text-rose-500'
                        : 'text-accent hover:bg-accent/10'
                    }`}
                  >
                    {s.active ? (
                      <X size={14} />
                    ) : (
                      <span className="text-xs">+</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {extras.length > 0 && (
        <>
          <span className="label">
            <UsersRound size={11} className="mr-1 inline" />
            {dict.sceneCasting.extrasLabel}
          </span>
          <div className="flex flex-wrap gap-2">
            {extras.map((e) => {
              const focused = focus?.kind === 'extra' && focus.id === e.id;
              return (
                <span
                  key={e.id}
                  className={`inline-flex items-center gap-1.5 rounded-full border py-1 pl-3 pr-1.5 text-xs transition-colors ${
                    e.active
                      ? focused
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-silver-300 dark:border-silver-700'
                      : 'border-dashed border-silver-300 text-silver-400 line-through decoration-silver-400/60 dark:border-silver-700'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => focusExtra(e.id)}
                    disabled={saving}
                    aria-pressed={focused}
                    className="inline-flex min-h-[44px] max-w-[180px] items-center truncate"
                    title={e.description}
                  >
                    {e.label}
                  </button>
                  <button
                    type="button"
                    aria-label={
                      e.active
                        ? dict.sceneCasting.removeExtra
                        : dict.sceneCasting.restoreExtra
                    }
                    onClick={() => toggleExtra(e.id)}
                    disabled={saving}
                    className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full p-0.5 disabled:opacity-50 ${
                      e.active
                        ? 'text-silver-400 hover:bg-rose-500/10 hover:text-rose-500'
                        : 'text-accent hover:bg-accent/10'
                    }`}
                  >
                    {e.active ? (
                      <X size={12} />
                    ) : (
                      <span className="px-1 text-[11px]">+</span>
                    )}
                  </button>
                </span>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-silver-400">
            {dict.sceneCasting.extrasNote}
          </p>
        </>
      )}
    </Card>
  );
}
