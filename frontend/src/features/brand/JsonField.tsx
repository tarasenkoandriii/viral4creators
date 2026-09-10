/**
 * Free-form JSON object editor for `filters` / `effects`. The schema is
 * the spec's open question §12.1 (settled in Stage 15) — so this stays an
 * honest "advanced" textarea validated only as "plain JSON object", the
 * same rule the backend enforces (≤16 KB, not an array).
 */

import { useEffect, useState } from 'react';
import { Field, Textarea } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import type { JsonObject } from '../../types/project';
import { parseJsonObject } from './json-object';

export function JsonField({
  id,
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  value: JsonObject | null;
  onChange: (v: JsonObject | null, valid: boolean) => void;
  disabled?: boolean;
}) {
  const { dict } = useI18n();
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(value ? JSON.stringify(value, null, 2) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);

  return (
    <Field label={label} htmlFor={id} hint={hint} error={error ?? undefined}>
      <Textarea
        id={id}
        rows={4}
        value={text}
        disabled={disabled}
        invalid={!!error}
        className="font-mono text-xs"
        placeholder={'{\n  "preset": "warm"\n}'}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          const r = parseJsonObject(next, dict.jsonObject);
          setError(r.error);
          onChange(r.value, r.error === null);
        }}
      />
    </Field>
  );
}
