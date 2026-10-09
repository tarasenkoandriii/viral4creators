/**
 * Раздел «Голосова карта адмінки» вкладки «Голос» «Админки» (заход 11,
 * №117; ТЗ §5-кватер.2, §5-кватер.9 «Изоляция», §5-кватер.13; В-55):
 *  - сводка черновика и ворот, «Открыть редактор в админке» (одноразовая
 *    ссылка на хост самой админки во внешнем браузере), «Завершить все
 *    сессии»;
 *  - цели: имя и синонимы на uk/ru/en (правка — здесь же), риск, где
 *    действует, «удалить/вернуть»; новая цель без пикера — текст и тип
 *    элемента (+ data-assist-id), «запретить» — без имён;
 *  - шаблоны страниц админки (маска пути);
 *  - версии: собрать, ПУБЛИКАЦИЯ — только здесь, отклонить, вернуть
 *    версию N (новой версией), экспорт/импорт файла `kind: admin`.
 * Только владелец «Админки» (экран выше; сервер — тоже). Без Pro — только
 * просмотр (сервер отвечает 402 на изменения).
 */
import { useRef, useState } from 'react';
import { Download, ExternalLink, ShieldOff, Upload } from 'lucide-react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import { Alert, Badge, Button, inputClass } from '../../kit/ui';
import { ADMIN_VOICE_MAP_TEXTS } from '../../i18n/admin-voice-map';
import {
  adminVoiceMapErrorCode,
  MAP_LANGS,
  MAP_TARGET_ROLES,
  namesOp,
  targetOp,
  type AdminMapTarget,
  type AdminMapTemplate,
  type MapLang,
  type MapTargetRole,
} from '../../lib/admin-voice-map-api';
import { useAssist } from '../../lib/assist-context';
import { openExternal } from '../../lib/open-link';
import { useErrorText } from '../../lib/use-error-text';
import type {
  MapVersionDetail,
  MapVersionStatus,
} from '../../lib/voice-map-api';
import { NoticeBar, type Notice } from '../knowledge/parts';

const box =
  'rounded-lg border border-silver-200 dark:border-silver-800 p-2 text-xs space-y-1';

function tone(s: MapVersionStatus) {
  return s === 'published'
    ? 'success'
    : s === 'held'
      ? 'warning'
      : s === 'discarded'
        ? 'danger'
        : 'neutral';
}

const splitList = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 20);

export function AdminVoiceMapSection({ siteId }: { siteId: string }) {
  const { adminMode } = useAssist();
  const { locale } = useKit();
  const t = ADMIN_VOICE_MAP_TEXTS[locale];
  const errText = useErrorText();
  const api = adminMode.voiceMap;
  const sum = useAsync(() => api.summary(siteId), [api, siteId]);
  const draft = useAsync(() => api.draft(siteId), [api, siteId]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [open, setOpen] = useState<MapVersionDetail | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const file = useRef<HTMLInputElement | null>(null);
  if (!sum.data || !draft.data) return null;
  const s = sum.data;
  const d = draft.data;
  const ro = !s.planAllows;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      const code = adminVoiceMapErrorCode(e);
      setNotice({ tone: 'danger', text: code ? t.errors[code] : errText(e) });
    } finally {
      setBusy(false);
      sum.reload();
      draft.reload();
    }
  };
  const patch = (ops: unknown[]) =>
    run(async () => {
      await api.patch(siteId, d.revision, ops);
      setNotice({ tone: 'success', text: t.saved });
      setEditing(null);
      setAdding(false);
    });

  const g = s.draftGates;
  const templates = d.templates.filter((x) => x.status === 'active');
  return (
    <div className="space-y-2 rounded-xl border border-silver-200 dark:border-silver-800 p-3">
      <div className="font-semibold text-sm flex items-center justify-between gap-2">
        <span>{t.title}</span>
        <Badge tone={s.publishedVersion ? 'success' : 'neutral'}>
          {s.publishedVersion
            ? fmt(t.published, { v: s.publishedVersion })
            : '—'}
        </Badge>
      </div>
      <p className="text-xs text-silver-500">{t.intro}</p>
      {ro && <Alert tone="warning">{t.needPlan}</Alert>}
      {!s.hosts.length && <Alert tone="warning">{t.noHosts}</Alert>}
      <NoticeBar notice={notice} />
      <Button
        icon={<ExternalLink size={16} />}
        loading={busy}
        disabled={busy || ro || !s.hosts.length}
        onClick={() =>
          void run(async () => {
            const l = await api.editorLink(siteId, {});
            openExternal(l.url);
          })
        }
      >
        {t.open}
      </Button>
      <p className="text-[11px] text-silver-500">{t.linkHint}</p>
      {!s.publishedVersion && <p className="text-xs">{t.none}</p>}
      <p className="text-xs">
        {fmt(t.draft, {
          t: s.targets,
          d: s.denylisted,
          s: s.templates,
          f: s.fragile,
        })}
      </p>
      {s.draftDirty && <p className="text-xs text-amber-600">{t.dirty}</p>}
      <p className="text-xs">
        {g.ok ? t.gatesOk : fmt(t.gatesBad, { n: g.problems.length })}
      </p>
      {!g.ok && (
        <ul className="text-xs list-disc pl-5">
          {g.problems.slice(0, 10).map((p, i) => (
            <li key={i}>
              {t.gates[p.code]}
              {p.key ? ` · ${p.key}` : ''}
              {p.phrase ? ` · «${p.phrase}»` : ''}
            </li>
          ))}
        </ul>
      )}

      <div className="text-xs font-medium pt-1">{t.targetsTitle}</div>
      {!d.targets.length && (
        <p className="text-xs text-silver-500">{t.targetsEmpty}</p>
      )}
      {d.targets.map((x) =>
        editing === x.key ? (
          <TargetNames
            key={x.key}
            target={x}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={(names, synonyms) =>
              void patch([namesOp(x.key, names, synonyms)])
            }
          />
        ) : (
          <div key={x.key} className={box}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                {x.names[locale as MapLang] || x.names.uk || x.text || x.key}
              </span>
              <span className="flex gap-1">
                <Badge tone={x.risk === 'now' ? 'success' : 'warning'}>
                  {t.risks[x.risk]}
                </Badge>
                {x.denylisted && <Badge tone="danger">{t.denylisted}</Badge>}
                {x.status === 'removed' && <Badge>{t.removed}</Badge>}
              </span>
            </div>
            <div className="text-silver-500">
              {x.key} · {t.scopes[x.scope]}
              {x.pagePath ? ` ${x.pagePath}` : ''}
              {x.templateId
                ? ` ${templates.find((p) => p.id === x.templateId)?.pathPattern ?? ''}`
                : ''}{' '}
              · {t.element}: «{x.text || x.assistId || '—'}»
            </div>
            {MAP_LANGS.filter(
              (l) => x.names[l] || x.synonyms[l].length > 0
            ).map((l) => (
              <div key={l}>
                {t.langs[l]}: {x.names[l] || '—'}
                {x.synonyms[l].length ? ` · ${x.synonyms[l].join(', ')}` : ''}
              </div>
            ))}
            {!ro && (
              <div className="flex flex-wrap gap-2">
                {x.status === 'active' && !x.denylisted && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setEditing(x.key)}
                  >
                    {t.edit}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void patch([
                      {
                        op:
                          x.status === 'removed'
                            ? 'restore-target'
                            : 'remove-target',
                        key: x.key,
                      },
                    ])
                  }
                >
                  {x.status === 'removed' ? t.restore : t.remove}
                </Button>
              </div>
            )}
          </div>
        )
      )}
      {!ro &&
        (adding ? (
          <NewTarget
            templates={templates}
            busy={busy}
            onCancel={() => setAdding(false)}
            onSave={(op) => void patch([op])}
          />
        ) : (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setAdding(true)}
          >
            {t.add}
          </Button>
        ))}

      <Templates
        templates={templates}
        readOnly={ro}
        busy={busy}
        onAdd={(name, pathPattern) =>
          void patch([
            { op: 'upsert-template', template: { name, pathPattern } },
          ])
        }
        onRemove={(id) => void patch([{ op: 'remove-template', id }])}
      />

      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          variant="outline"
          disabled={busy || ro}
          onClick={() =>
            void run(async () => {
              setOpen(await api.build(siteId));
            })
          }
        >
          {t.build}
        </Button>
        <Button
          variant="outline"
          icon={<Download size={16} />}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const f = await api.exportFile(siteId);
              const blob = new Blob([f.json], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = f.name;
              a.click();
              URL.revokeObjectURL(a.href);
            })
          }
        >
          {t.export}
        </Button>
        <Button
          variant="outline"
          icon={<Upload size={16} />}
          disabled={busy || ro}
          onClick={() => file.current?.click()}
        >
          {t.import}
        </Button>
        <input
          ref={file}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            void run(async () => {
              const json: unknown = JSON.parse(await f.text());
              const r = await api.importFile(siteId, d.revision, json);
              setNotice({
                tone: r.rejected ? 'warning' : 'success',
                text: fmt(t.imported, {
                  a: r.accepted,
                  r: r.rejected,
                  s: r.signed ? t.importSigned : '',
                }),
              });
            });
          }}
        />
      </div>
      <div className="text-xs flex items-center justify-between gap-2">
        <span>{fmt(t.sessions, { n: s.activeSessions })}</span>
        {s.activeSessions > 0 && (
          <Button
            variant="ghost"
            icon={<ShieldOff size={14} />}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.revokeSessions(siteId);
                setNotice({ tone: 'success', text: t.revoked });
              })
            }
          >
            {t.revoke}
          </Button>
        )}
      </div>
      {s.versions.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium">{t.versions}</div>
          {s.versions.map((v) => (
            <div key={v.number} className={box}>
              <div className="flex items-center justify-between gap-2">
                <span>
                  v{v.number} ·{' '}
                  {fmt(t.diff, {
                    a: v.diff.added,
                    c: v.diff.changed,
                    r: v.diff.removed,
                  })}
                  {v.requestedVia === 'editor' ? ` · ${t.viaEditor}` : ''}
                </span>
                <Badge tone={tone(v.status)}>{t.status[v.status]}</Badge>
              </div>
              <div className="text-silver-500">
                {formatDate(v.publishedAt ?? v.createdAt, locale)} ·{' '}
                {v.ok ? t.gatesOk : fmt(t.gatesBad, { n: v.problems })}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  onClick={() =>
                    void run(async () =>
                      setOpen(
                        open?.number === v.number
                          ? null
                          : await api.version(siteId, v.number)
                      )
                    )
                  }
                >
                  …
                </Button>
                {v.status === 'checking' && !ro && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.publish(siteId, v.number);
                        setNotice({
                          tone: 'success',
                          text: fmt(t.publishedOk, { n: v.number }),
                        });
                      })
                    }
                  >
                    {t.publish}
                  </Button>
                )}
                {(v.status === 'checking' || v.status === 'held') && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.discard(siteId, v.number);
                      })
                    }
                  >
                    {t.discard}
                  </Button>
                )}
                {v.status === 'published' &&
                  v.number !== s.publishedVersion &&
                  !ro && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const back = await api.rollback(siteId, v.number);
                          setOpen(back);
                          if (back)
                            setNotice({
                              tone: 'success',
                              text: fmt(t.rollbackOk, { n: back.number }),
                            });
                        })
                      }
                    >
                      {t.rollback}
                    </Button>
                  )}
              </div>
              {open?.number === v.number && (
                <ul className="list-disc pl-5">
                  {open.targets.map((x) => (
                    <li key={x.key}>
                      {x.name || x.key} · {x.key} · {x.scope} · {x.risk}
                      {x.denylisted ? ' · ⛔' : ''}
                      {open.diffKeys.added.includes(x.key) ? ' · +' : ''}
                      {open.diffKeys.changed.includes(x.key) ? ' · ~' : ''}
                    </li>
                  ))}
                  {open.diffKeys.removed.map((k) => (
                    <li key={`r-${k}`}>− {k}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Имена и синонимы цели на трёх языках (дескриптор и риск — прежние). */
function TargetNames({
  target,
  busy,
  onSave,
  onCancel,
}: {
  target: AdminMapTarget;
  busy: boolean;
  onSave: (
    names: Record<MapLang, string>,
    synonyms: Record<MapLang, string[]>
  ) => void;
  onCancel: () => void;
}) {
  const { locale } = useKit();
  const t = ADMIN_VOICE_MAP_TEXTS[locale];
  const [names, setNames] = useState(target.names);
  const [syn, setSyn] = useState<Record<MapLang, string>>(
    Object.fromEntries(
      MAP_LANGS.map((l) => [l, target.synonyms[l].join(', ')])
    ) as Record<MapLang, string>
  );
  return (
    <div className={box}>
      <div className="font-medium">{target.key}</div>
      {MAP_LANGS.map((l) => (
        <div key={l} className="grid grid-cols-[2.5rem_1fr] gap-1 items-center">
          <span>{t.langs[l]}</span>
          <div className="space-y-1">
            <input
              className={inputClass}
              maxLength={60}
              placeholder={t.name}
              value={names[l]}
              onChange={(e) => setNames({ ...names, [l]: e.target.value })}
            />
            <input
              className={inputClass}
              placeholder={`${t.synonyms} (${t.synonymsHint})`}
              value={syn[l]}
              onChange={(e) => setSyn({ ...syn, [l]: e.target.value })}
            />
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          disabled={busy}
          onClick={() =>
            onSave(
              names,
              Object.fromEntries(
                MAP_LANGS.map((l) => [l, splitList(syn[l])])
              ) as Record<MapLang, string[]>
            )
          }
        >
          {t.save}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t.cancel}
        </Button>
      </div>
    </div>
  );
}

/** Новая цель без пикера: текст и тип элемента, где действует, имена. */
function NewTarget({
  templates,
  busy,
  onSave,
  onCancel,
}: {
  templates: AdminMapTemplate[];
  busy: boolean;
  onSave: (op: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const { locale } = useKit();
  const t = ADMIN_VOICE_MAP_TEXTS[locale];
  const [key, setKey] = useState('');
  const [text, setText] = useState('');
  const [role, setRole] = useState<MapTargetRole>('link');
  const [assistId, setAssistId] = useState('');
  const [scope, setScope] = useState<'site' | 'page' | 'template'>('site');
  const [pagePath, setPagePath] = useState('/');
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [deny, setDeny] = useState(false);
  const [names, setNames] = useState<Record<MapLang, string>>({
    uk: '',
    ru: '',
    en: '',
  });
  const [syn, setSyn] = useState<Record<MapLang, string>>({
    uk: '',
    ru: '',
    en: '',
  });
  return (
    <div className={box}>
      <div className="font-medium">{t.addTitle}</div>
      <input
        className={inputClass}
        placeholder={`${t.key} — ${t.keyHint}`}
        value={key}
        onChange={(e) => setKey(e.target.value.toLowerCase())}
      />
      <input
        className={inputClass}
        maxLength={80}
        placeholder={t.text}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <label className="flex items-center gap-2">
        <span>{t.role}</span>
        <select
          className={inputClass}
          value={role}
          onChange={(e) => setRole(e.target.value as MapTargetRole)}
        >
          {MAP_TARGET_ROLES.map((r) => (
            <option key={r} value={r}>
              {t.roles[r]}
            </option>
          ))}
        </select>
      </label>
      <input
        className={inputClass}
        placeholder={t.assistId}
        value={assistId}
        onChange={(e) => setAssistId(e.target.value.trim())}
      />
      <label className="flex items-center gap-2">
        <span>{t.scope}</span>
        <select
          className={inputClass}
          value={scope}
          onChange={(e) =>
            setScope(e.target.value as 'site' | 'page' | 'template')
          }
        >
          <option value="site">{t.scopes.site}</option>
          <option value="page">{t.scopes.page}</option>
          {templates.length > 0 && (
            <option value="template">{t.scopes.template}</option>
          )}
        </select>
      </label>
      {scope === 'page' && (
        <input
          className={inputClass}
          placeholder={t.pagePath}
          value={pagePath}
          onChange={(e) => setPagePath(e.target.value)}
        />
      )}
      {scope === 'template' && (
        <select
          className={inputClass}
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
        >
          {templates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.pathPattern})
            </option>
          ))}
        </select>
      )}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={deny}
          onChange={(e) => setDeny(e.target.checked)}
        />
        <span>{t.deny}</span>
      </label>
      {!deny &&
        MAP_LANGS.map((l) => (
          <div
            key={l}
            className="grid grid-cols-[2.5rem_1fr] gap-1 items-center"
          >
            <span>{t.langs[l]}</span>
            <div className="space-y-1">
              <input
                className={inputClass}
                maxLength={60}
                placeholder={t.name}
                value={names[l]}
                onChange={(e) => setNames({ ...names, [l]: e.target.value })}
              />
              <input
                className={inputClass}
                placeholder={`${t.synonyms} (${t.synonymsHint})`}
                value={syn[l]}
                onChange={(e) => setSyn({ ...syn, [l]: e.target.value })}
              />
            </div>
          </div>
        ))}
      <div className="flex gap-2">
        <Button
          disabled={busy || !key || (!text && !assistId)}
          onClick={() =>
            onSave(
              targetOp({
                key,
                text,
                role,
                assistId: assistId || null,
                scope,
                pagePath,
                templateId,
                names: deny ? {} : names,
                synonyms: deny
                  ? {}
                  : (Object.fromEntries(
                      MAP_LANGS.map((l) => [l, splitList(syn[l])])
                    ) as Record<MapLang, string[]>),
                denylisted: deny,
              })
            )
          }
        >
          {t.save}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t.cancel}
        </Button>
      </div>
    </div>
  );
}

function Templates({
  templates,
  readOnly,
  busy,
  onAdd,
  onRemove,
}: {
  templates: AdminMapTemplate[];
  readOnly: boolean;
  busy: boolean;
  onAdd: (name: string, pathPattern: string) => void;
  onRemove: (id: string) => void;
}) {
  const { locale } = useKit();
  const t = ADMIN_VOICE_MAP_TEXTS[locale];
  const [name, setName] = useState('');
  const [mask, setMask] = useState('');
  return (
    <div className="space-y-1 pt-1">
      <div className="text-xs font-medium">{t.templatesTitle}</div>
      {templates.map((p) => (
        <div
          key={p.id}
          className="text-xs flex items-center justify-between gap-2"
        >
          <span>
            {p.name} · {p.pathPattern}
          </span>
          {!readOnly && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => onRemove(p.id)}
            >
              {t.remove}
            </Button>
          )}
        </div>
      ))}
      {!readOnly && (
        <div className="flex flex-wrap gap-2 items-center">
          <input
            className={inputClass}
            maxLength={60}
            placeholder={t.templateName}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className={inputClass}
            maxLength={200}
            placeholder={t.templateMask}
            value={mask}
            onChange={(e) => setMask(e.target.value.trim())}
          />
          <Button
            variant="outline"
            disabled={busy || !name.trim() || !mask.startsWith('/')}
            onClick={() => onAdd(name.trim(), mask)}
          >
            {t.templateAdd}
          </Button>
        </div>
      )}
    </div>
  );
}
