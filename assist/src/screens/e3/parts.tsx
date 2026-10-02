import { useId, useState, type ReactNode } from 'react';
import {
  BarChart3,
  GraduationCap,
  Headset,
  MessagesSquare,
  Plug,
  Target,
} from 'lucide-react';
import { useAsync, useKit, type Site } from '../../kit';
import {
  Alert,
  Button,
  Card,
  ScreenTitle,
  Spinner,
  inputClass,
} from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { canSeeStats, hasAssist } from '../../lib/e3-view';
import type { Texts } from '../../lib/engagement-types';
import { navigate } from '../../lib/router';
import { WIDGET_UI_LANGS, type WidgetUiLang } from '../../lib/widget-types';
import { LoadError } from '../knowledge/parts';

/** Кнопки разделов Э3 в карточке сайта (по правам участника). */
export function SiteE3Buttons({ siteId }: { siteId: string }) {
  const { account } = useKit();
  const { appDict } = useAssist();
  const t = appDict.e3.site;
  if (!hasAssist(account.me)) return null;
  const manager = canSeeStats(account.me);
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        icon={<MessagesSquare size={16} />}
        onClick={() => navigate({ name: 'dialogs', siteId })}
      >
        {t.dialogs}
      </Button>
      {manager && (
        <>
          <Button
            variant="outline"
            icon={<Headset size={16} />}
            onClick={() => navigate({ name: 'handoff', siteId })}
          >
            {t.handoff}
          </Button>
          <Button
            variant="outline"
            icon={<BarChart3 size={16} />}
            onClick={() => navigate({ name: 'stats', siteId, tab: 'overview' })}
          >
            {t.stats}
          </Button>
          <Button
            variant="outline"
            icon={<Target size={16} />}
            onClick={() => navigate({ name: 'goals', siteId })}
          >
            {t.goals}
          </Button>
          <Button
            variant="outline"
            icon={<Plug size={16} />}
            onClick={() => navigate({ name: 'integrations', siteId })}
          >
            {t.integrations}
          </Button>
        </>
      )}
      <Button
        variant="outline"
        icon={<GraduationCap size={16} />}
        onClick={() => navigate({ name: 'learning', siteId, tab: 'queue' })}
      >
        {t.learning}
      </Button>
    </div>
  );
}

/** Экран раздела без сайта в адресе: список сайтов кабинета → действие. */
export function SitePickerScreen({
  title,
  intro,
  render,
}: {
  title: string;
  intro?: string;
  render: (site: Site) => ReactNode;
}) {
  const { api, dict } = useKit();
  const { appDict } = useAssist();
  const sites = useAsync(() => api.listSites(), [api]);
  return (
    <div className="space-y-4">
      <ScreenTitle>{title}</ScreenTitle>
      {intro && <p className="text-sm text-silver-500">{intro}</p>}
      {sites.loading && !sites.data ? (
        <Spinner label={dict.common.loading} />
      ) : !sites.data ? (
        <LoadError error={sites.error} onRetry={sites.reload} />
      ) : sites.data.length === 0 ? (
        <Card className="text-sm">{appDict.e3.common.noSites}</Card>
      ) : (
        sites.data.map((s) => (
          <Card key={s.id} className="space-y-2">
            <div className="font-semibold truncate">{s.name}</div>
            {render(s)}
          </Card>
        ))
      )}
    </div>
  );
}

/** «Нет доступа» — раздел только для manager/owner. */
export function ManagerOnly() {
  const { appDict } = useAssist();
  return <Alert tone="warning">{appDict.e3.common.noAccessManager}</Alert>;
}

/** Тексты на языках интерфейса виджета: вкладка языка + поле. */
export function TextsInput({
  label,
  value,
  onChange,
  max,
  multiline,
}: {
  label: (lang: WidgetUiLang) => string;
  value: Texts;
  onChange: (v: Texts) => void;
  max: number;
  multiline?: boolean;
}) {
  const { appDict } = useAssist();
  const [lang, setLang] = useState<WidgetUiLang>('uk');
  const id = useId();
  const set = (s: string) => {
    const next = { ...value };
    if (s) next[lang] = s;
    else delete next[lang];
    onChange(next);
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm font-medium flex-1">
          {label(lang)}
        </label>
        <div className="flex gap-1" role="group">
          {WIDGET_UI_LANGS.map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={l === lang}
              title={appDict.e3.common.langs[l]}
              onClick={() => setLang(l)}
              className={`rounded px-2 py-0.5 text-xs ${
                l === lang
                  ? 'bg-accent text-accent-on'
                  : value[l]
                    ? 'bg-silver-200 dark:bg-silver-800'
                    : 'text-silver-500'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      {multiline ? (
        <textarea
          id={id}
          className={`${inputClass} min-h-[72px]`}
          maxLength={max}
          value={value[lang] ?? ''}
          onChange={(e) => set(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className={inputClass}
          maxLength={max}
          value={value[lang] ?? ''}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </div>
  );
}

/** Маски путей — по одной в строке. */
export function MasksInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [raw, setRaw] = useState(value.join('\n'));
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        className={`${inputClass} min-h-[64px] font-mono text-xs`}
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          onChange(
            e.target.value
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, 20)
          );
        }}
      />
    </div>
  );
}

/** Маленькая таблица чисел (статистика, недели). */
export function MiniTable({
  head,
  rows,
}: {
  head: ReactNode[];
  rows: ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-silver-500">
            {head.map((h, i) => (
              <th key={i} className="py-1 pr-3 font-normal whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              className="border-t border-silver-200 dark:border-silver-800"
            >
              {r.map((c, j) => (
                <td key={j} className="py-1 pr-3 whitespace-nowrap">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
