/**
 * Раздел «Голос → Мемо» (Э6-бис (е), ТЗ §5-бис.17 п.14; решения владельца
 * Р-68…Р-72): список мемо сайта (`М-N`, имя, статус, вид вёрстки, успех
 * цели за 30 дней, «требует проверки» с причиной), счётчик «N из лимита
 * тарифа», «Новое мемо», «Кандидаты (N)» из боя; карточка мемо — имена и
 * фразы по языкам (с принятием предложенного), цель (описание и условия),
 * шаги с пометками ↺/⇄/⚠/✋ (порядок и удаление — списком), слоты,
 * «Я умею», версии с отчётами ворот и прогона, «Проверить на сайте»
 * (ссылка мастера), «Опубликовать» (подтверждение человеком), «Вернуть
 * версию N» (с новым прогоном), выключение и удаление, статистика.
 * Запись кликами и перепривязка мышкой — редактор (Э6-тер).
 */
import { useState } from 'react';
import {
  ArrowUp,
  ExternalLink,
  PlusCircle,
  Save,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import { Alert, Badge, Button, CopyField, inputClass } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import {
  MEMO_LANGS,
  goalExpectForSave,
  memoReadOnly,
  type MemoDetail,
  type MemoLang,
  type MemoOp,
  type MemoStatus,
} from '../../lib/memo-api';
import { openExternal } from '../../lib/open-link';
import { useSetupErrorText } from '../../lib/use-error-text';
import { pct, voiceControlErrorCode } from '../../lib/voice-control-api';
import { canManageWidget } from '../../lib/widget-view';
import { NoticeBar, type Notice } from '../knowledge/parts';
import { Field, Toggle } from './controls';
import { MemoFromTemplate } from './MemoFromTemplate';
import { MemoFromTutorial } from './MemoFromTutorial';

const MARK: Record<string, string> = {
  local: '↺',
  comp: '⇄',
  irrev: '⚠',
  manual: '✋',
  never: '✋',
};

function statusTone(s: MemoStatus) {
  return s === 'published'
    ? 'success'
    : s === 'needs_review' || s === 'held'
      ? 'warning'
      : s === 'disabled' || s === 'removed'
        ? 'danger'
        : 'neutral';
}

export function MemoSection({ siteId }: { siteId: string }) {
  const { appDict, voiceControl } = useAssist();
  const { locale, account } = useKit();
  const t = appDict.voiceControl.memo;
  const tv = appDict.voiceControl;
  const errText = useSetupErrorText();
  const canEdit = canManageWidget(account.me);
  const list = useAsync(
    () => (canEdit ? voiceControl.memo.list(siteId) : Promise.resolve(null)),
    [voiceControl, siteId, canEdit]
  );
  const [name, setName] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [cands, setCands] = useState<Awaited<
    ReturnType<typeof voiceControl.memo.suggestions>
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const fail = (e: unknown) => {
    const code = voiceControlErrorCode(e);
    setNotice({ tone: 'danger', text: code ? tv.errors[code] : errText(e) });
  };
  if (memoReadOnly(account.me, list.error))
    return (
      <div className="space-y-2 rounded-xl border border-silver-200 dark:border-silver-800 p-3">
        <div className="font-semibold text-sm">{t.title}</div>
        <Alert tone="warning">{t.readOnly}</Alert>
      </div>
    );
  if (!list.data) return null;
  const l = list.data;

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const d = await voiceControl.memo.create(siteId, {
        name: name.trim(),
        lang: locale as MemoLang,
      });
      setName('');
      list.reload();
      if (d) setOpen(d.number);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const fromCandidate = async (planId: string) => {
    setBusy(true);
    try {
      const d = await voiceControl.memo.fromSuggestion(siteId, planId);
      setCands(null);
      list.reload();
      if (d) setOpen(d.number);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-silver-200 dark:border-silver-800 p-3">
      <div className="font-semibold text-sm flex items-center justify-between gap-2">
        <span>{t.title}</span>
        <Badge tone={l.used >= l.limit ? 'warning' : 'neutral'}>
          {fmt(t.used, { used: l.used, limit: l.limit })}
        </Badge>
      </div>
      <p className="text-xs text-silver-500">{t.intro}</p>
      <p className="text-[11px] text-silver-500">{t.marks}</p>
      <NoticeBar notice={notice} />
      <div className="flex gap-2">
        <input
          className={inputClass}
          placeholder={t.newName}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          icon={<PlusCircle size={16} />}
          loading={busy}
          disabled={busy || !name.trim() || l.used >= l.limit}
          onClick={() => void create()}
        >
          {t.create}
        </Button>
      </div>
      <MemoFromTutorial
        siteId={siteId}
        full={l.used >= l.limit}
        onCreated={(n) => {
          list.reload();
          setOpen(n);
        }}
        onOpen={setOpen}
      />
      <MemoFromTemplate
        siteId={siteId}
        full={l.used >= l.limit}
        onChanged={() => list.reload()}
      />
      {l.candidates > 0 && (
        <Button
          variant="outline"
          onClick={() =>
            cands
              ? setCands(null)
              : void voiceControl.memo
                  .suggestions(siteId)
                  .then(setCands)
                  .catch(fail)
          }
        >
          {fmt(t.candidates, { n: l.candidates })}
        </Button>
      )}
      {cands && (
        <div className="space-y-2 text-xs">
          <p className="text-silver-500">{t.candidatesIntro}</p>
          {cands.map((c) => (
            <div
              key={c.planId}
              className="rounded-lg border border-silver-200 dark:border-silver-800 p-2 space-y-1"
            >
              <div>
                {c.page} · {c.visitors}
              </div>
              <ol className="list-decimal pl-5">
                {c.steps.map((s, i) => (
                  <li key={i}>
                    {s.kind} «{s.text}»
                  </li>
                ))}
              </ol>
              {c.phrases.length > 0 && (
                <div className="text-silver-500">
                  «{c.phrases.join('», «')}»
                </div>
              )}
              <Button
                variant="outline"
                disabled={busy || l.used >= l.limit}
                onClick={() => void fromCandidate(c.planId)}
              >
                {t.saveCandidate}
              </Button>
            </div>
          ))}
        </div>
      )}
      {l.items.length === 0 && <p className="text-xs">{t.empty}</p>}
      <ul className="space-y-1">
        {l.items.map((m) => (
          <li
            key={m.number}
            className="rounded-lg border border-silver-200 dark:border-silver-800 p-2 text-xs space-y-1"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                М-{m.number} · {m.name ?? m.key}
              </span>
              <span className="flex gap-1">
                {m.overPlan && (
                  <Badge tone="warning">
                    <span title={t.overPlanHint}>{t.overPlan}</span>
                  </Badge>
                )}
                <Badge tone={statusTone(m.status)}>{t.status[m.status]}</Badge>
              </span>
            </div>
            {m.overPlan && (
              <div className="text-amber-700">{t.overPlanHint}</div>
            )}
            <div className="text-silver-500">
              {t.views[m.view]} ·{' '}
              {fmt(t.success, {
                pct: pct(m.reached30, m.runs30),
                n: m.runs30,
              })}
              {m.lastRunAt ? ` · ${formatDate(m.lastRunAt, locale)}` : ''}
              {m.reviewCode
                ? ` · ${t.review[m.reviewCode as keyof typeof t.review] ?? m.reviewCode}`
                : ''}
            </div>
            <Button
              variant="ghost"
              onClick={() => setOpen(open === m.number ? null : m.number)}
            >
              {open === m.number ? t.close : t.open}
            </Button>
            {open === m.number && (
              <MemoCard
                siteId={siteId}
                n={m.number}
                onChanged={() => list.reload()}
                onRemoved={() => {
                  setOpen(null);
                  list.reload();
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MemoCard({
  siteId,
  n,
  onChanged,
  onRemoved,
}: {
  siteId: string;
  n: number;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const { appDict, voiceControl } = useAssist();
  const { locale, dict } = useKit();
  const t = appDict.voiceControl.memo;
  const tv = appDict.voiceControl;
  const errText = useSetupErrorText();
  const api = voiceControl.memo;
  const loaded = useAsync(() => api.get(siteId, n), [api, siteId, n]);
  const stats = useAsync(() => api.stats(siteId, n, 7), [api, siteId, n]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [edit, setEdit] = useState<{
    names: Partial<Record<MemoLang, string>>;
    triggers: Partial<Record<MemoLang, string>>;
    goalText: string;
    goalUrl: string;
    goalAppear: string;
  } | null>(null);
  const d = loaded.data;
  if (!d) return null;
  const draft = d.draft;
  const lang = locale as MemoLang;
  const e = edit ?? {
    names: { ...draft.names },
    triggers: Object.fromEntries(
      MEMO_LANGS.map((l) => [l, (draft.triggers[l] ?? []).join('\n')])
    ) as Partial<Record<MemoLang, string>>,
    goalText: draft.goal.text[lang] ?? '',
    goalUrl: draft.goal.expect.find((g) => g.kind === 'url')?.path ?? '',
    goalAppear: draft.goal.expect.find((g) => g.kind === 'text')?.text ?? '',
  };
  const set = (p: Partial<typeof e>) => setEdit({ ...e, ...p });

  const run = async (fn: () => Promise<MemoDetail | null | void>) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      if (r) loaded.setData(r);
      setEdit(null);
      onChanged();
      setNotice({ tone: 'success', text: tv.saved });
    } catch (err) {
      const code = voiceControlErrorCode(err);
      setNotice({
        tone: 'danger',
        text: code ? tv.errors[code] : errText(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const patch = (ops: MemoOp[]) =>
    run(() => api.patch(siteId, n, d.draftRevision, ops));

  const saveDraft = () => {
    const triggers: Partial<Record<MemoLang, string[]>> = {};
    for (const l of MEMO_LANGS) {
      const list = (e.triggers[l] ?? '')
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
      if (list.length) triggers[l] = list;
    }
    const names: Partial<Record<MemoLang, string>> = {};
    for (const l of MEMO_LANGS)
      if (e.names[l]?.trim()) names[l] = e.names[l]!.trim();
    const expect = goalExpectForSave(
      draft.goal.expect,
      e.goalUrl,
      e.goalAppear
    );
    return patch([
      { op: 'set', field: 'names', value: names },
      { op: 'set', field: 'triggers', value: triggers },
      {
        op: 'set',
        field: 'goal',
        value: {
          text: { ...draft.goal.text, [lang]: e.goalText.trim() || undefined },
          expect,
        },
      },
    ]);
  };

  const latest = d.versions[0] ?? null;
  const checking = d.versions.find((v) => v.status === 'checking') ?? null;

  return (
    <div className="space-y-2 pt-2">
      <NoticeBar notice={notice} />
      {MEMO_LANGS.map((l) => (
        <Field
          key={`n${l}`}
          label={`${t.names} · ${l}`}
          htmlFor={`mn-${n}-${l}`}
        >
          <input
            id={`mn-${n}-${l}`}
            className={inputClass}
            maxLength={60}
            value={e.names[l] ?? ''}
            onChange={(x) =>
              set({ names: { ...e.names, [l]: x.target.value } })
            }
          />
        </Field>
      ))}
      {MEMO_LANGS.map((l) => (
        <Field
          key={`t${l}`}
          label={`${t.triggers} · ${l}`}
          htmlFor={`mt-${n}-${l}`}
        >
          <textarea
            id={`mt-${n}-${l}`}
            className={inputClass}
            rows={2}
            value={e.triggers[l] ?? ''}
            onChange={(x) =>
              set({ triggers: { ...e.triggers, [l]: x.target.value } })
            }
          />
          {(draft.suggested[l] ?? []).length > 0 && (
            <div className="text-xs space-y-1">
              <div className="text-silver-500">{t.suggested}</div>
              {(draft.suggested[l] ?? []).map((p) => (
                <div key={p} className="flex items-center gap-2">
                  <span>«{p}»</span>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void patch([
                        { op: 'acceptSuggested', lang: l, phrase: p },
                      ])
                    }
                  >
                    {t.accept}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Field>
      ))}
      <div className="font-medium text-sm">{t.goal}</div>
      <Field label={t.goalText} htmlFor={`mg-${n}`}>
        <input
          id={`mg-${n}`}
          className={inputClass}
          maxLength={160}
          value={e.goalText}
          onChange={(x) => set({ goalText: x.target.value })}
        />
      </Field>
      <Field label={t.goalUrl} htmlFor={`mu-${n}`}>
        <input
          id={`mu-${n}`}
          className={inputClass}
          value={e.goalUrl}
          placeholder="/cart*"
          onChange={(x) => set({ goalUrl: x.target.value })}
        />
      </Field>
      <Field label={t.goalAppear} htmlFor={`ma-${n}`}>
        <input
          id={`ma-${n}`}
          className={inputClass}
          maxLength={80}
          value={e.goalAppear}
          onChange={(x) => set({ goalAppear: x.target.value })}
        />
      </Field>
      {draft.goal.expect.some(
        (g) => g.kind === 'counter' || g.kind === 'field' || g.kind === 'slot'
      ) && (
        <ul className="text-xs list-disc pl-5">
          {draft.goal.expect.map((g, i) =>
            g.kind === 'counter' ? (
              <li key={i}>
                {fmt(t.goalCounter, {
                  t: g.target?.text || g.target?.assistId || '',
                  d: `${(g.delta ?? 0) > 0 ? '+' : ''}${g.delta ?? 0}`,
                })}
              </li>
            ) : g.kind === 'field' ? (
              <li key={i}>
                {fmt(t.goalField, {
                  t: g.target?.text || g.target?.assistId || '',
                  slot: g.slot ?? '',
                })}
              </li>
            ) : g.kind === 'slot' ? (
              <li key={i}>{fmt(t.goalSlot, { slot: g.slot ?? '' })}</li>
            ) : null
          )}
        </ul>
      )}
      <div className="font-medium text-sm">{t.steps}</div>
      <ol className="space-y-1 text-xs">
        {draft.steps.map((s, i) => (
          <li key={i} className="flex items-center justify-between gap-2">
            <span>
              {i + 1}. {MARK[d.gates.undo[i] ?? ''] ?? ''}{' '}
              {MARK[d.gates.risk[i] ?? ''] ?? ''} {s.action}
              {s.target ? ` «${s.target.text}»` : ''}
              {s.value
                ? 'slot' in s.value
                  ? ` ← {${s.value.slot}}`
                  : ` = «${s.value.const}»`
                : ''}{' '}
              <span className="text-silver-500">{s.page}</span>
            </span>
            <span className="flex gap-1">
              <Button
                variant="ghost"
                aria-label={t.up}
                disabled={busy || i === 0}
                icon={<ArrowUp size={14} />}
                onClick={() =>
                  void patch([{ op: 'moveStep', from: i, to: i - 1 }])
                }
              />
              <Button
                variant="ghost"
                aria-label={t.remove}
                disabled={busy}
                icon={<Trash2 size={14} />}
                onClick={() => void patch([{ op: 'removeStep', index: i }])}
              />
            </span>
          </li>
        ))}
      </ol>
      {draft.slots.length > 0 && (
        <div className="text-xs">
          <div className="font-medium">{t.slots}</div>
          <ul className="list-disc pl-5">
            {draft.slots.map((s) => (
              <li key={s.name}>
                {s.name}: {s.kind}
                {s.pii ? ' · ПД' : ''}
                {s.options.length ? ` (${s.options.join(', ')})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Toggle
        checked={d.listed}
        label={t.listed}
        onChange={(v) => void patch([{ op: 'listed', value: v }])}
      />
      {d.gates.ok ? (
        <p className="text-xs text-emerald-700">{t.gatesOk}</p>
      ) : (
        <ul className="text-xs text-amber-700 list-disc pl-5">
          {d.gates.problems.map((p, i) => (
            <li key={i}>
              {t.gates[p.code]}{' '}
              <span className="text-silver-500">{p.path}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          icon={<Save size={16} />}
          loading={busy}
          disabled={busy}
          onClick={() => void saveDraft()}
        >
          {t.saveDraft}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run(() => api.build(siteId, n))}
        >
          {t.build}
        </Button>
        {checking && (
          <Button
            variant="outline"
            icon={<ShieldCheck size={16} />}
            disabled={busy}
            onClick={() =>
              void api
                .checkToken(siteId, n)
                .then((r) => setLink(r.url))
                .catch((err: unknown) => {
                  const code = voiceControlErrorCode(err);
                  setNotice({
                    tone: 'danger',
                    text: code ? tv.errors[code] : errText(err),
                  });
                })
            }
          >
            {t.check}
          </Button>
        )}
        {checking && (
          <Button
            disabled={busy || !checking.check || checking.check === 'fail'}
            onClick={() =>
              void run(() => api.publish(siteId, n, checking.number))
            }
          >
            {fmt(t.publish, { n: checking.number })}
          </Button>
        )}
      </div>
      {link && (
        <div className="space-y-2">
          <CopyField
            label={t.checkLink}
            value={link}
            copyLabel={dict.common.copy}
            copiedLabel={dict.common.copied}
          />
          <Button
            variant="outline"
            icon={<ExternalLink size={16} />}
            onClick={() => openExternal(link)}
          >
            {tv.wizard.open}
          </Button>
        </div>
      )}
      {d.versions.length > 0 && (
        <div className="text-xs space-y-1">
          <div className="font-medium">{t.versions}</div>
          {d.versions.map((v) => (
            <div key={v.number} className="flex flex-wrap items-center gap-2">
              <span>
                {fmt(t.version, { n: v.number, status: v.status })}
                {v.check ? ` · ${t.checkResult[v.check]}` : ''}
                {v.publishedAt ? ` · ${formatDate(v.publishedAt, locale)}` : ''}
              </span>
              {(v.status === 'checking' || v.status === 'held') && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.discard(siteId, n, v.number))
                  }
                >
                  {t.discard}
                </Button>
              )}
              {v !== latest && v.status === 'published' && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.rollback(siteId, n, v.number))
                  }
                >
                  {fmt(t.rollback, { n: v.number })}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {stats.data && (
        <div className="grid grid-cols-2 gap-x-3 text-xs">
          <span className="col-span-2 font-medium">
            {fmt(t.stats, { n: stats.data.windowDays })}
          </span>
          <span>{t.statRuns}</span>
          <span>{stats.data.runs}</span>
          <span>{t.statReached}</span>
          <span>{pct(stats.data.reached, stats.data.runs)}</span>
          <span>{t.statDirect}</span>
          <span>
            {stats.data.direct} / {stats.data.lite}
          </span>
          <span>{t.statPin}</span>
          <span>{stats.data.pinMismatch}</span>
          <span>{t.statSelf}</span>
          <span>{stats.data.self}</span>
        </div>
      )}
      {d.status === 'needs_review' && d.reviewCode && (
        <Alert tone="warning">
          {t.review[d.reviewCode as keyof typeof t.review] ?? d.reviewCode}
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        {d.status === 'disabled' ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => api.enable(siteId, n))}
          >
            {t.enable}
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => api.disable(siteId, n))}
          >
            {t.disable}
          </Button>
        )}
        <Button
          variant="danger"
          disabled={busy}
          onClick={() =>
            void api
              .remove(siteId, n)
              .then(onRemoved)
              .catch((err: unknown) =>
                setNotice({ tone: 'danger', text: errText(err) })
              )
          }
        >
          {t.remove_memo}
        </Button>
      </div>
    </div>
  );
}
