import { useState } from 'react';
import { Alert, Badge, Button, Card } from '../../../kit/ui';
import type { ChannelView } from '../../../lib/publisher/calendar-api';
import {
  CHANNEL_CREATE_KINDS,
  channelCreateBody,
  channelFieldErrors,
  channelForm,
  channelPatchBody,
  type AdsChoice,
  type ChannelForm,
} from '../../../lib/publisher/channels-view';
import { CHANNEL_STATUSES } from '../../../lib/publisher/states';
import { fmtText } from '../../../lib/publisher/view';
import { useMutation, usePubApis, usePubContent } from '../hooks';
import {
  EmptyState,
  Field,
  Loadable,
  Notice,
  PubErrorAlert,
  Section,
  Select,
  StatusBadge,
  TextArea,
  TextInput,
} from '../parts';
import { usePublisher } from '../publisher-context';

const ADS: readonly AdsChoice[] = ['yes', 'no', 'unknown'];

/**
 * Каналы F09 (`channel.manage` — PO/OP, как `core/roles.ts`): список для
 * всех, создание и правка — по праву. «Реклама разрешена» не выдумывается:
 * `null` — «невідомо». Код и вид после создания не меняются (сервер их не
 * принимает); канал `site` заводит продукт.
 */
export function ChannelsPanel({
  state,
}: {
  state: {
    data: ChannelView[] | null;
    error: Error | null;
    loading: boolean;
    reload: () => void;
  };
}) {
  const { can } = usePublisher();
  const c = usePubContent();
  const k = c.channels;
  const manage = can('channel.manage');
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <Section
      title={k.title}
      action={
        manage && !adding ? (
          <Button variant="outline" onClick={() => setAdding(true)}>
            {k.add}
          </Button>
        ) : null
      }
    >
      <p className="text-xs text-silver-500">{k.hint}</p>
      <Notice text={notice} />
      {manage && adding && (
        <ChannelEditor
          channel={null}
          onDone={(saved) => {
            setAdding(false);
            if (saved) {
              setNotice(k.added);
              state.reload();
            }
          }}
        />
      )}
      <Loadable state={state}>
        {(items) =>
          items.length ? (
            <ul className="divide-y divide-silver-200 dark:divide-silver-800">
              {items.map((ch) => (
                <ChannelRow
                  key={ch.id}
                  channel={ch}
                  manage={manage}
                  onSaved={() => {
                    setNotice(k.saved);
                    state.reload();
                  }}
                />
              ))}
            </ul>
          ) : (
            <EmptyState />
          )
        }
      </Loadable>
    </Section>
  );
}

function ChannelRow({
  channel: ch,
  manage,
  onSaved,
}: {
  channel: ChannelView;
  manage: boolean;
  onSaved: () => void;
}) {
  const c = usePubContent();
  const k = c.channels;
  const [editing, setEditing] = useState(false);
  return (
    <li className="py-2 space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium break-all">{ch.title}</span>
        <code className="text-xs text-silver-500 break-all">{ch.code}</code>
        <Badge tone="neutral">{k.kinds[ch.kind]}</Badge>
        <StatusBadge
          status={ch.status}
          labels={k.statuses}
          tone={ch.status === 'available' ? 'neutral' : 'warning'}
        />
      </div>
      <div className="text-xs text-silver-500 flex flex-wrap gap-x-3 gap-y-1">
        <span className="break-all">
          utm_source={ch.utmSource} · utm_medium={ch.utmMedium}
        </span>
        <span>
          {k.ads}:{' '}
          {ch.adsAllowed === null ? (
            <Badge tone="warning">{k.adsValues.unknown}</Badge>
          ) : (
            k.adsValues[ch.adsAllowed ? 'yes' : 'no']
          )}
        </span>
      </div>
      {ch.rulesNote && (
        <div className="text-xs whitespace-pre-wrap break-words">
          {k.rulesNote}: {ch.rulesNote}
        </div>
      )}
      {ch.kind === 'site' && (
        <div className="text-xs text-silver-500">{k.siteNote}</div>
      )}
      {ch.status === 'unavailable' && (
        <div className="text-xs text-amber-700">{k.unavailableHint}</div>
      )}
      {manage &&
        (editing ? (
          <ChannelEditor
            channel={ch}
            onDone={(saved) => {
              setEditing(false);
              if (saved) onSaved();
            }}
          />
        ) : (
          <Button variant="ghost" onClick={() => setEditing(true)}>
            {k.edit}
          </Button>
        ))}
    </li>
  );
}

/** Форма канала: `channel=null` — создание, иначе правка изменённых полей. */
function ChannelEditor({
  channel: ch,
  onDone,
}: {
  channel: ChannelView | null;
  onDone: (saved: boolean) => void;
}) {
  const c = usePubContent();
  const apis = usePubApis();
  const k = c.channels;
  const [f, setF] = useState<ChannelForm>(() => channelForm(ch));
  const m = useMutation();
  const set =
    <K extends keyof ChannelForm>(key: K) =>
    (v: ChannelForm[K]) =>
      setF((x) => ({ ...x, [key]: v }));
  const creating = ch === null;
  const bad = channelFieldErrors(f, creating);
  const touched =
    f.title !== (ch?.title ?? '') ||
    f.utmSource !== (ch?.utmSource ?? '') ||
    f.utmMedium !== (ch?.utmMedium ?? '') ||
    f.code !== (ch?.code ?? '');
  const fieldName: Record<(typeof bad)[number], string> = {
    code: k.code,
    title: k.titleField,
    kind: k.kind,
    utmSource: k.utmSource,
    utmMedium: k.utmMedium,
  };
  const createBody = creating ? channelCreateBody(f) : null;
  const patchBody = ch ? channelPatchBody(ch, f) : null;
  return (
    <Card className="space-y-2">
      {creating && (
        <>
          <Field label={k.code} hint={k.codeHint}>
            <TextInput value={f.code} onChange={set('code')} maxLength={64} />
          </Field>
          <Field label={k.kind}>
            <Select
              value={f.kind as (typeof CHANNEL_CREATE_KINDS)[number] | ''}
              options={CHANNEL_CREATE_KINDS}
              labels={k.kinds}
              empty="—"
              onChange={set('kind')}
            />
          </Field>
        </>
      )}
      <Field label={k.titleField}>
        <TextInput value={f.title} onChange={set('title')} maxLength={200} />
      </Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={k.utmSource} hint={k.utmHint}>
          <TextInput
            value={f.utmSource}
            onChange={set('utmSource')}
            maxLength={100}
          />
        </Field>
        <Field label={k.utmMedium} hint={k.utmHint}>
          <TextInput
            value={f.utmMedium}
            onChange={set('utmMedium')}
            maxLength={100}
          />
        </Field>
      </div>
      <Field label={k.ads}>
        <Select
          value={f.ads}
          options={ADS}
          labels={k.adsValues}
          onChange={(v) => set('ads')(v || 'unknown')}
        />
      </Field>
      <Field label={k.rulesNote}>
        <TextArea
          value={f.rulesNote}
          onChange={set('rulesNote')}
          maxLength={2000}
        />
      </Field>
      {!creating && (
        <Field label={k.status}>
          <Select
            value={f.status as (typeof CHANNEL_STATUSES)[number]}
            options={CHANNEL_STATUSES}
            labels={k.statuses}
            onChange={(v) => set('status')(v || 'available')}
          />
        </Field>
      )}
      {touched && bad.length > 0 && (
        <Alert tone="warning">
          {fmtText(k.invalid, {
            list: bad.map((b) => fieldName[b]).join(', '),
          })}
        </Alert>
      )}
      {!creating && !patchBody && bad.length === 0 && (
        <div className="text-xs text-silver-500">{k.nothingChanged}</div>
      )}
      <PubErrorAlert error={m.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          loading={m.busy}
          disabled={creating ? !createBody : !patchBody}
          onClick={async () => {
            const r = creating
              ? createBody &&
                (await m.run(
                  (key) => apis.calendar.createChannel(createBody, key),
                  JSON.stringify(['createChannel', createBody])
                ))
              : ch &&
                patchBody &&
                (await m.run(
                  (key) => apis.calendar.patchChannel(ch.id, patchBody, key),
                  JSON.stringify(['patchChannel', ch.id, patchBody])
                ));
            if (r) onDone(true);
          }}
        >
          {creating ? k.add : k.save}
        </Button>
        <Button variant="ghost" onClick={() => onDone(false)}>
          {k.cancel}
        </Button>
      </div>
    </Card>
  );
}
