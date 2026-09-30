/**
 * Образы персоны (ТЗ Greeting 2.0 §4.1 п.5, §4.2, §4.4, §4.5): галерея и
 * форма нового образа.
 *
 * Число образов не ограничено (§4.2) — ограничены деньги: квота день/
 * месяц показывается прямо у кнопки, и кнопка гаснет ДО отказа сервера,
 * а не после потраченной попытки.
 *
 * Возраст — ползунок 18…90 всегда (§4.4, Т-6), предупреждение при сдвиге
 * больше 20 лет — до нажатия, той же формулой, что у сервера
 * (`referenceAge` в lib/persona-flow.ts).
 *
 * «Скетч» — существующий поток скетча со слотом `persona-look` (§4.5):
 * лицо в нём не анонимизируется, это решает сервер по проверенной
 * персоне, клиент ничего особенного не шлёт.
 */

import { useMemo, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Field,
  Input,
  Pills,
  Select,
  Textarea,
} from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { navigate, routes } from '../../lib/router';
import { errorMessage } from '../../services/projects-api';
import {
  createLook,
  deleteLook,
  isPersonaQuotaRefusal,
  personaErrorQuota,
  renameLook,
} from '../../services/persona-api';
import {
  ageShiftWarns,
  canCreateLook,
  clampTargetAge,
  defaultTargetAge,
  galleryLooks,
  lookCreateBody,
  lookDisplayLabel,
  lookSourceChoice,
  quotaRefusalState,
  lookState,
  LOOK_DESCRIPTION_MAX,
  LOOK_LABEL_MAX,
  LOOK_PRESETS,
  LOOK_WARNING_AGE_SHIFT,
  personaQuotaState,
  quotaLine,
  referenceAge,
  TARGET_AGE_MAX,
  TARGET_AGE_MIN,
  type LookPreset,
  type PersonaLook,
  type PersonaMe,
} from '../../lib/persona-flow';
import { SketchSlotActions } from '../sketch/SketchSlotActions';

export function PersonaLooks({
  me,
  onChanged,
}: {
  me: PersonaMe;
  /** Перечитать персону: квота, статусы образов. */
  onChanged: () => void;
}) {
  const { dict } = useI18n();
  const t = dict.persona;
  const looks = useMemo(() => galleryLooks(me.looks), [me.looks]);

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <CardHeader title={t.looksTitle} hint={t.likenessNote} />
        {looks.length === 0 ? (
          <p className="text-sm text-silver-400">{t.looksEmpty}</p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="list">
            {looks.map((look) => (
              <LookCard key={look.id} look={look} onChanged={onChanged} />
            ))}
          </ul>
        )}
      </Card>
      <NewLookForm me={me} looks={looks} onCreated={onChanged} />
    </div>
  );
}

function LookCard({
  look,
  onChanged,
}: {
  look: PersonaLook;
  onChanged: () => void;
}) {
  const { dict } = useI18n();
  const t = dict.persona;
  const state = lookState(look);
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(look.label);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sketchUrl, setSketchUrl] = useState<string | null>(look.sketchUrl);
  const shown = sketchUrl ?? look.photoUrl;
  const preset = look.preset
    ? ((t.presets as Record<string, string>)[look.preset] ?? null)
    : null;
  const shownLabel = lookDisplayLabel(look, t);

  const saveLabel = async () => {
    const next = label.trim();
    if (!next || next === look.label) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await renameLook(look.id, next.slice(0, LOOK_LABEL_MAX));
      setRenaming(false);
      onChanged();
    } catch (e) {
      setError(errorMessage(e, undefined, dict.errors));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteLook(look.id);
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(errorMessage(e, undefined, dict.errors));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-xl border border-silver-200/70 p-2 dark:border-silver-800">
      <div className="relative aspect-square overflow-hidden rounded-lg bg-silver-100 dark:bg-silver-900">
        {state === 'ready' && shown ? (
          <img
            src={shown}
            alt={t.lookAlt.replace('{{label}}', shownLabel)}
            className="h-full w-full object-cover"
            loading="lazy"
            // Лицо человека — не в снимки интерфейса и кадры обучалки.
            data-qa-mask="persona-look"
          />
        ) : (
          <div
            className="flex h-full items-center justify-center p-3 text-center text-xs text-silver-400"
            role="status"
          >
            {state === 'failed' ? look.error || t.lookFailed : t.lookPending}
          </div>
        )}
      </div>
      <div className="mt-2 space-y-2">
        {renaming ? (
          <div className="flex gap-2">
            <label className="sr-only" htmlFor={`look-label-${look.id}`}>
              {t.renameLabel}
            </label>
            <Input
              id={`look-label-${look.id}`}
              value={label}
              maxLength={LOOK_LABEL_MAX}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveLabel();
                if (e.key === 'Escape') setRenaming(false);
              }}
              disabled={busy}
            />
            <Button size="sm" loading={busy} onClick={() => void saveLabel()}>
              {t.save}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate text-sm font-medium">
              {shownLabel}
            </span>
            {look.isBase && <Badge tone="success">{t.lookBaseBadge}</Badge>}
            {preset && <Badge>{preset}</Badge>}
            {look.targetAge != null && (
              <span className="text-xs text-silver-400">
                {t.lookAge.replace('{{age}}', String(look.targetAge))}
              </span>
            )}
          </div>
        )}
        {error && (
          <Alert tone="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {state === 'ready' && (
            <SketchSlotActions
              target={{ type: 'persona-look', id: look.id }}
              hasImage={!!look.photoUrl}
              originalUrl={look.photoUrl}
              activeUrl={sketchUrl}
              variant={sketchUrl ? 'sketch' : 'original'}
              label={t.sketchButton}
              onSlot={(slot) =>
                setSketchUrl(slot.variant === 'sketch' ? slot.url : null)
              }
            />
          )}
          {!renaming && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Pencil size={13} />}
              aria-label={`${t.rename}: ${shownLabel}`}
              disabled={busy}
              onClick={() => {
                setLabel(shownLabel);
                setRenaming(true);
              }}
            />
          )}
          {/* Базовый образ не удаляется отдельно: после срока хранения
              селфи (В-3) он — единственный источник новых образов. Убрать
              его можно только вместе со всей персоной. */}
          {!look.isBase && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 size={13} />}
              aria-label={`${t.deleteLook}: ${shownLabel}`}
              disabled={busy}
              onClick={() => setConfirming(true)}
            />
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        title={t.deleteLook}
        confirmLabel={t.deleteLook}
        cancelLabel={t.cancel}
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirming(false)}
      >
        {t.deleteLookConfirm.replace('{{label}}', shownLabel)}
      </ConfirmDialog>
    </li>
  );
}

function NewLookForm({
  me,
  looks,
  onCreated,
}: {
  me: PersonaMe;
  looks: PersonaLook[];
  onCreated: () => void;
}) {
  const { dict } = useI18n();
  const t = dict.persona;
  const sources = looks.filter((l) => lookState(l) === 'ready');
  const [preset, setPreset] = useState<LookPreset | null>(null);
  const [description, setDescription] = useState('');
  const choice = lookSourceChoice(me.persona, looks);
  const [sourceId, setSourceId] = useState<string>(choice.defaultSourceId);
  const source = sources.find((l) => l.id === sourceId) ?? null;
  const reference = referenceAge(me.persona, source);
  const [age, setAge] = useState<number>(() => defaultTargetAge(reference));
  const [ageTouched, setAgeTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const quotaState = personaQuotaState(me.quota);
  const ready = canCreateLook({ preset, description, quota: me.quota });
  const warns = ageTouched && ageShiftWarns(age, reference);

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const look = await createLook(
        lookCreateBody({
          preset,
          description,
          // Ползунок не трогали — возраст источника решает сервер: так
          // деловой образ не «омолаживается» до середины оценки.
          targetAge: ageTouched ? age : null,
          sourceLookId: source?.id ?? null,
        })
      );
      if (look.warning === LOOK_WARNING_AGE_SHIFT) setNotice(t.ageShiftWarning);
      else if (look.warning) setNotice(look.warning);
      setDescription('');
      setPreset(null);
      onCreated();
    } catch (e) {
      // День или месяц — по остатку из ответа (`error.details.quota`),
      // а не всегда «на сегодня»: иначе месячный лимит обещал бы «завтра».
      setError(
        isPersonaQuotaRefusal(e)
          ? quotaRefusalState(personaErrorQuota(e)) === 'month-over'
            ? t.quotaMonthOver
            : t.quotaDayOver
          : errorMessage(e, undefined, dict.errors)
      );
      // Квота могла кончиться с другого устройства — перечитать остаток.
      if (isPersonaQuotaRefusal(e)) onCreated();
    } finally {
      setBusy(false);
    }
  };

  const presetOptions = [
    { value: '' as const, label: t.presetNone },
    ...LOOK_PRESETS.map((p) => ({
      value: p,
      label: (t.presets as Record<LookPreset, string>)[p],
    })),
  ];

  return (
    <Card className="p-4 sm:p-5">
      <CardHeader title={t.newLookTitle} hint={t.newLookLead} />
      <div className="space-y-4">
        <div>
          <span className="label" id="persona-preset-label">
            {t.presetLabel}
          </span>
          <Pills
            value={preset ?? ''}
            ariaLabel={t.presetLabel}
            columns={2}
            onChange={(v) => setPreset(v ? (v as LookPreset) : null)}
            options={presetOptions}
            disabled={busy}
          />
        </div>

        <Field
          label={t.descriptionLabel}
          htmlFor="persona-look-description"
          hint={t.descriptionHint}
          counter={`${description.length}/${LOOK_DESCRIPTION_MAX}`}
        >
          <Textarea
            id="persona-look-description"
            rows={3}
            value={description}
            placeholder={t.descriptionPlaceholder}
            onChange={(e) =>
              setDescription(e.target.value.slice(0, LOOK_DESCRIPTION_MAX))
            }
            disabled={busy}
          />
        </Field>

        {sources.length > 1 && (
          <Field label={t.sourceLabel} htmlFor="persona-look-source">
            <Select
              id="persona-look-source"
              value={sourceId}
              onChange={(e) => {
                setSourceId(e.target.value);
                const next =
                  sources.find((l) => l.id === e.target.value) ?? null;
                if (!ageTouched)
                  setAge(defaultTargetAge(referenceAge(me.persona, next)));
              }}
              disabled={busy}
            >
              {choice.selfieOption && (
                <option value="">{t.sourceSelfie}</option>
              )}
              {sources.map((l) => (
                <option key={l.id} value={l.id}>
                  {lookDisplayLabel(l, t)}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field
          label={t.targetAgeLabel.replace('{{age}}', String(age))}
          htmlFor="persona-look-age"
          hint={t.targetAgeHint}
        >
          <input
            id="persona-look-age"
            type="range"
            min={TARGET_AGE_MIN}
            max={TARGET_AGE_MAX}
            step={1}
            value={age}
            aria-valuetext={t.targetAgeValue.replace('{{age}}', String(age))}
            onChange={(e) => {
              setAge(clampTargetAge(Number(e.target.value)));
              setAgeTouched(true);
            }}
            disabled={busy}
            className="w-full accent-sky-400"
          />
        </Field>
        {warns && <Alert tone="warning">{t.ageShiftWarning}</Alert>}

        <p className="text-xs text-silver-400" aria-live="polite">
          {quotaLine(me.quota, t.quotaLine)}
        </p>
        {quotaState !== 'ok' && (
          <Alert tone="info">
            {quotaState === 'month-over' ? t.quotaMonthOver : t.quotaDayOver}
            {quotaState === 'month-over' && (
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(routes.plan())}
                >
                  {t.quotaUpgrade}
                </Button>
              </div>
            )}
          </Alert>
        )}
        {error && (
          <Alert tone="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
        {notice && (
          <Alert tone="warning" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        )}
        <div>
          <Button
            loading={busy}
            disabled={!ready}
            onClick={() => void create()}
          >
            {busy ? t.creating : t.createLook}
          </Button>
          {!ready && quotaState === 'ok' && !busy && (
            <p className="mt-1 text-xs text-silver-400">{t.createHint}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
