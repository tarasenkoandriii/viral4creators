/**
 * AudienceCard — one audience profile (spec §18): age, gender, interests,
 * summary. Read-only by default; with `onSave` it flips into a small form
 * (used on the product item screen, where the user corrects Gemini's
 * guess from the photo — the correction is stamped `source: 'user'` on
 * the server and survives a photo re-recognition).
 *
 * Deliberately compact: this sits next to the price and description, it
 * is context for the relevance check, not a marketing brief.
 */

import { useState } from 'react';
import { Check, Pencil, Users, X } from 'lucide-react';
import { Badge, Button, Field, Input, Pills, Textarea } from './ui';
import type { AudienceGender, AudienceProfile } from '../types';
import { genderLabel, audienceIsEmpty, parseInterests } from '../lib/audience';
import { useI18n } from '../lib/i18n-context';

export interface AudienceDraft {
  ageRange: string | null;
  gender: AudienceGender | null;
  interests: string[];
  summary: string | null;
}

/** Inline chips — reused by the analysis card and the relevance panel. */
export function AudienceChips({
  audience,
  tone = 'neutral',
}: {
  audience: AudienceProfile;
  tone?: 'neutral' | 'accent';
}) {
  const { dict } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-1">
      {audience.ageRange && <Badge tone={tone}>{audience.ageRange}</Badge>}
      {audience.gender && (
        <Badge tone={tone}>
          {genderLabel(audience.gender, dict.audience.genderLabels)}
        </Badge>
      )}
      {audience.interests.map((i) => (
        <Badge key={i}>{i}</Badge>
      ))}
    </div>
  );
}

export function AudienceCard({
  audience,
  title,
  emptyText,
  onSave,
  saving,
}: {
  audience: AudienceProfile | null | undefined;
  title?: string;
  emptyText?: string;
  /** Present → editable. Resolves after the server has stored it. */
  onSave?: (draft: AudienceDraft) => Promise<void>;
  saving?: boolean;
}) {
  const { dict } = useI18n();
  const heading = title ?? dict.audienceCard.defaultTitle;
  const emptyMessage = emptyText ?? dict.audienceCard.defaultEmptyText;
  const [editing, setEditing] = useState(false);
  const [ageRange, setAgeRange] = useState(audience?.ageRange ?? '');
  const [gender, setGender] = useState<AudienceGender | 'unset'>(
    audience?.gender ?? 'unset'
  );
  const [interests, setInterests] = useState(
    (audience?.interests ?? []).join(', ')
  );
  const [summary, setSummary] = useState(audience?.summary ?? '');
  const [error, setError] = useState<string | null>(null);

  const startEdit = () => {
    setAgeRange(audience?.ageRange ?? '');
    setGender(audience?.gender ?? 'unset');
    setInterests((audience?.interests ?? []).join(', '));
    setSummary(audience?.summary ?? '');
    setError(null);
    setEditing(true);
  };

  const submit = async () => {
    if (!onSave) return;
    try {
      await onSave({
        ageRange: ageRange.trim() || null,
        gender: gender === 'unset' ? null : gender,
        interests: parseInterests(interests),
        summary: summary.trim() || null,
      });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : dict.audienceCard.saveFailed);
    }
  };

  const header = (
    <div className="mb-2 flex items-center gap-2">
      <Users size={14} className="text-accent" />
      <span className="label !mb-0">{heading}</span>
      {audience && (
        <Badge tone={audience.source === 'user' ? 'accent' : 'neutral'}>
          {audience.source === 'user'
            ? dict.audienceCard.sourceManual
            : dict.audienceCard.sourcePhoto}
        </Badge>
      )}
      {onSave && !editing && (
        <button
          type="button"
          aria-label={dict.audienceCard.editAriaLabel}
          onClick={startEdit}
          className="ml-auto rounded-lg p-1 text-silver-400 hover:text-accent"
        >
          <Pencil size={13} />
        </button>
      )}
    </div>
  );

  if (editing && onSave) {
    return (
      <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
        {header}
        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label={dict.audienceCard.age} htmlFor="aud-age">
              <Input
                id="aud-age"
                value={ageRange}
                maxLength={80}
                placeholder="25-34"
                onChange={(e) => setAgeRange(e.target.value)}
                disabled={saving}
              />
            </Field>
            <div>
              <span className="label">{dict.audienceCard.gender}</span>
              <Pills
                value={gender}
                onChange={setGender}
                disabled={saving}
                options={[
                  { value: 'women', label: dict.audienceCard.genderWomen },
                  { value: 'men', label: dict.audienceCard.genderMen },
                  { value: 'any', label: dict.audienceCard.genderAny },
                  { value: 'unset', label: '—' },
                ]}
              />
            </div>
          </div>
          <Field
            label={dict.audienceCard.interests}
            htmlFor="aud-interests"
            hint={dict.audienceCard.interestsHint}
          >
            <Input
              id="aud-interests"
              value={interests}
              placeholder={dict.audienceCard.interestsPlaceholder}
              onChange={(e) => setInterests(e.target.value)}
              disabled={saving}
            />
          </Field>
          <Field
            label={dict.audienceCard.summary}
            htmlFor="aud-summary"
            counter={dict.audienceCard.counter.replace(
              '{{count}}',
              String(summary.length)
            )}
            error={error}
          >
            <Textarea
              id="aud-summary"
              rows={2}
              value={summary}
              onChange={(e) => setSummary(e.target.value.slice(0, 600))}
              disabled={saving}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon={<X size={14} />}
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              {dict.audienceCard.cancel}
            </Button>
            <Button
              type="button"
              size="sm"
              icon={<Check size={14} />}
              loading={saving}
              onClick={() => void submit()}
            >
              {dict.audienceCard.save}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-silver-200/70 p-3 dark:border-silver-800">
      {header}
      {audienceIsEmpty(audience) ? (
        <p className="text-xs text-silver-400">{emptyMessage}</p>
      ) : (
        <>
          <AudienceChips audience={audience!} tone="accent" />
          {audience!.summary && (
            <p className="mt-2 text-xs leading-relaxed text-silver-500 dark:text-silver-400">
              {audience!.summary}
            </p>
          )}
        </>
      )}
    </div>
  );
}
