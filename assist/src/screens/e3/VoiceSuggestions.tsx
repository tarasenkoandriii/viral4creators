/**
 * Заход 13 (Р-З13-Б3; хвост захода 11) — «Обучение → Голос»: карточки
 * терминов распознавания и «вела не туда», как «Пропозиції» панели
 * редактора, но без пикера:
 *  - «Додати термін» — в черновик карты (`set-terms`, та же операция, что
 *    у панели);
 *  - «Перепривʼязати» — выбор правильной цели из списка; фраза — её
 *    синоним, со старой снимается (если была синонимом);
 *  - «Не пропонувати» — 30 дней (общий журнал с панелью).
 * Оптимистично: карточка прячется сразу, при отказе возвращается; ревизия
 * черновика — `expectedRevision` (409 — список перечитывается). После
 * «Додати»/«Перепривʼязати» — «Скасувати» (обратные операции сервера тем же
 * `PATCH …/draft`; карту успели поменять — 409, «не вийшло»).
 */
import { useState } from 'react';
import { fmt, useAsync, useKit } from '../../kit';
import { Button, Card, inputClass } from '../../kit/ui';
import { VOICE_SUGGESTION_TEXTS } from '../../i18n/voice-suggestions';
import { useAssist } from '../../lib/assist-context';
import { navigate } from '../../lib/router';
import { useErrorText } from '../../lib/use-error-text';
import {
  rebindChoices,
  visibleSuggestions,
  voiceMapErrorCode,
  type SuggestionAction,
  type VoiceSuggestions,
  type WrongCard,
} from '../../lib/voice-map-api';
import { NoticeBar, type Notice } from '../knowledge/parts';

export function VoiceSuggestionCards({ siteId }: { siteId: string }) {
  const { locale } = useKit();
  const { appDict, voiceControl } = useAssist();
  const api = voiceControl.voiceMap;
  const t = VOICE_SUGGESTION_TEXTS[locale];
  const mapErrors = appDict.voiceControl.voiceMap.errors;
  const errText = useErrorText();
  const loaded = useAsync(() => api.suggestions(siteId), [api, siteId]);
  const [fresh, setFresh] = useState<VoiceSuggestions | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [undo, setUndo] = useState<{ revision: number; ops: unknown[] } | null>(
    null
  );
  const [changed, setChanged] = useState(false);
  const v = fresh ?? loaded.data;
  if (!v) return null;

  const errOf = (e: unknown) => {
    const code = voiceMapErrorCode(e);
    if (code === 'VOICE_MAP_CONFLICT') return t.conflict;
    return code ? mapErrors[code] : errText(e);
  };
  const refresh = async () => {
    try {
      setFresh(await api.suggestions(siteId));
      setHidden([]);
    } catch {
      // Список перечитаем при следующем действии; карточки остаются как есть.
    }
  };
  const nameOf = (key: string) =>
    v.targets.find((x) => x.key === key)?.name ?? key;

  /** Оптимистичное действие над карточкой `id`: спрятать → запрос → откат при отказе. */
  const act = async (
    id: string,
    run: (revision: number) => Promise<SuggestionAction | null>,
    ok: (r: SuggestionAction | null) => string
  ) => {
    setBusy(id);
    setNotice(null);
    setUndo(null);
    setHidden((h) => [...h, id]);
    try {
      const r = await run(v.revision);
      if (r) {
        setFresh({ ...v, revision: r.revision });
        setChanged(true);
        if (r.undo.length) setUndo({ revision: r.revision, ops: r.undo });
      }
      setNotice({ tone: 'success', text: ok(r) });
      await refresh();
    } catch (e) {
      setHidden((h) => h.filter((x) => x !== id));
      const code = voiceMapErrorCode(e);
      if (code === 'VOICE_MAP_CONFLICT' || code === 'VOICE_MAP_SUGGESTION_GONE')
        await refresh();
      setNotice({ tone: 'danger', text: errOf(e) });
    } finally {
      setBusy(null);
    }
  };

  const doUndo = async () => {
    if (!undo) return;
    setBusy('undo');
    try {
      await api.patch(siteId, undo.revision, undo.ops);
      setNotice({ tone: 'success', text: t.undone });
    } catch (e) {
      setNotice({
        tone: 'warning',
        text:
          voiceMapErrorCode(e) === 'VOICE_MAP_CONFLICT' ? t.undoLate : errOf(e),
      });
    } finally {
      setUndo(null);
      setBusy(null);
      await refresh();
    }
  };

  const mute = (id: string) =>
    act(
      id,
      async () => {
        await api.muteSuggestion(siteId, id);
        return null;
      },
      () => t.muted
    );

  const rebind = (w: WrongCard) => {
    const to = pick[w.id];
    if (!to) return;
    return act(
      w.id,
      (rev) => api.rebind(siteId, rev, w.id, to),
      (r) => {
        const d = r as SuggestionAction & { detached?: boolean };
        return [
          fmt(t.rebindDone, { p: w.phrase, k: nameOf(to) }),
          d?.detached ? fmt(t.detached, { k: nameOf(w.key) }) : '',
        ]
          .filter(Boolean)
          .join(' ');
      }
    );
  };

  const shown = visibleSuggestions(v, hidden);
  return (
    <Card className="space-y-2 text-sm" data-voice-suggestions="">
      <div className="font-semibold">{t.title}</div>
      <p className="text-xs text-silver-500">{fmt(t.intro, { d: v.days })}</p>
      <NoticeBar notice={notice} />
      {(undo || changed) && (
        <div className="flex flex-wrap gap-2">
          {undo && (
            <Button
              variant="outline"
              loading={busy === 'undo'}
              disabled={busy !== null}
              onClick={() => void doUndo()}
            >
              {t.undo}
            </Button>
          )}
          {changed && (
            <Button
              variant="ghost"
              onClick={() => navigate({ name: 'persona', siteId })}
            >
              {t.openMap}
            </Button>
          )}
        </div>
      )}
      {shown.terms.length === 0 && shown.wrong.length === 0 && (
        <p className="text-xs">{t.empty}</p>
      )}
      {shown.terms.map((c) => (
        <div
          key={c.id}
          className="space-y-1 rounded-lg border border-silver-200 dark:border-silver-800 p-2"
        >
          <p>{fmt(t.term, { p: c.phrase, v: c.visitors })}</p>
          {v.termsLeft === 0 && (
            <p className="text-xs text-silver-500">{t.termsFull}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              loading={busy === c.id}
              disabled={busy !== null || v.termsLeft === 0}
              onClick={() =>
                void act(
                  c.id,
                  (rev) => api.acceptTerm(siteId, rev, c.id),
                  () => fmt(t.termDone, { p: c.phrase })
                )
              }
            >
              {t.addTerm}
            </Button>
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void mute(c.id)}
            >
              {t.mute}
            </Button>
          </div>
        </div>
      ))}
      {shown.wrong.map((w) => {
        const choices = rebindChoices(v, w);
        return (
          <div
            key={w.id}
            className="space-y-1 rounded-lg border border-silver-200 dark:border-silver-800 p-2"
          >
            <p>
              {fmt(t.wrong, { p: w.phrase, k: nameOf(w.key), v: w.visitors })}
            </p>
            {w.nameClash && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {fmt(t.nameClash, { p: w.phrase, k: nameOf(w.key) })}
              </p>
            )}
            {choices.length === 0 ? (
              <p className="text-xs text-silver-500">{t.noTargets}</p>
            ) : (
              <label className="block text-xs text-silver-500">
                {t.to}
                <select
                  className={inputClass}
                  value={pick[w.id] ?? ''}
                  onChange={(e) => setPick({ ...pick, [w.id]: e.target.value })}
                >
                  <option value="">{t.choose}</option>
                  {choices.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.name} · {x.page ?? t.scope[x.scope]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                loading={busy === w.id}
                disabled={busy !== null || !pick[w.id]}
                onClick={() => void rebind(w)}
              >
                {t.rebind}
              </Button>
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void mute(w.id)}
              >
                {t.mute}
              </Button>
            </div>
          </div>
        );
      })}
    </Card>
  );
}
