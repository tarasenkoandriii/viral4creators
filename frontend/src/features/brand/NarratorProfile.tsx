import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Field, Select } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import {
  errorMessage,
  getBrandManifest,
  updateBrandManifest,
  uploadNarratorPreamble,
} from '../../services/projects-api';
import type { BrandManifestView } from '../../types/project';

/** The character's existing SketchSlotActions own image variants; voice stays in VoicePicker. */
export function NarratorProfile({
  manifest,
  onSaved,
}: {
  manifest: BrandManifestView;
  onSaved: (m: BrandManifestView) => void;
}) {
  const { dict, locale } = useI18n();
  const t = dict.narratorProfile;
  const [characterId, setCharacterId] = useState(
    manifest.narratorCharacterId ?? ''
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [language, setLanguage] = useState<string>(locale);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCharacterId(manifest.narratorCharacterId ?? '');
  }, [manifest.narratorCharacterId]);
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const character = manifest.characters.find((c) => c.id === characterId);
  return (
    <Card className="p-5 space-y-4">
      <h2 className="font-semibold">{t.title}</h2>
      <p className="text-sm text-silver-400">{t.hint}</p>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label={t.image} htmlFor="narrator-character">
        <Select
          id="narrator-character"
          value={characterId}
          disabled={busy}
          onChange={(e) => setCharacterId(e.target.value)}
        >
          <option value="">{t.none}</option>
          {manifest.narratorCharacterId &&
            !manifest.characters.some(
              (c) => c.id === manifest.narratorCharacterId
            ) && (
              <option value={manifest.narratorCharacterId} disabled>
                {t.none}
              </option>
            )}
          {manifest.characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
      {character?.photoUrl && (
        <img
          src={character.photoUrl}
          alt={character.label}
          className="h-28 w-28 rounded-xl object-cover"
        />
      )}
      <Button
        disabled={busy || characterId === (manifest.narratorCharacterId ?? '')}
        onClick={() =>
          void run(async () => {
            onSaved(
              await updateBrandManifest(manifest.id, {
                narratorCharacterId: characterId || null,
              })
            );
          })
        }
      >
        {t.save}
      </Button>
      <p className="text-sm text-silver-400">
        Для Story‑Tales выберите свой готовый клон в настройке голоса брендбука.
        В «Репке» он появится как отдельный вариант с подтверждением согласия;
        Nova по умолчанию не меняется.{' '}
        <a className="underline" href="#/stories">
          Открыть сказки
        </a>
      </p>
      <h3 className="font-medium">{t.preamble}</h3>
      <p className="text-xs text-silver-400">{t.recordingHint}</p>
      {(preview || manifest.tutorialPreamble?.url) && (
        <video
          controls
          preload="metadata"
          src={preview ?? manifest.tutorialPreamble?.url}
          className="max-h-64 w-full rounded-xl"
        />
      )}
      {manifest.tutorialPreamble && (
        <p className="text-xs text-silver-400">
          {manifest.tutorialPreamble.locale.toUpperCase()} ·{' '}
          {manifest.tutorialPreamble.seconds.toFixed(2)} s
        </p>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="video/mp4"
        disabled={busy}
        aria-label={t.preamble}
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          setApproved(false);
        }}
      />
      <Field label={t.locale} htmlFor="preamble-language">
        <Select
          id="preamble-language"
          value={language}
          disabled={busy}
          onChange={(e) => {
            setLanguage(e.target.value);
            setApproved(false);
          }}
        >
          {['ru', 'uk', 'en', 'de', 'es'].map((l) => (
            <option key={l} value={l}>
              {l.toUpperCase()}
            </option>
          ))}
        </Select>
      </Field>
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={approved}
          disabled={busy || !file}
          onChange={(e) => setApproved(e.target.checked)}
        />
        {t.approved}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            busy ||
            !file ||
            !approved ||
            characterId !== (manifest.narratorCharacterId ?? '')
          }
          loading={busy}
          onClick={() =>
            void run(async () => {
              if (
                !file ||
                file.size > 20 * 1024 * 1024 ||
                file.type !== 'video/mp4' ||
                !approved
              )
                throw new Error(t.invalid);
              await uploadNarratorPreamble(manifest.id, file, language);
              onSaved(await getBrandManifest(manifest.id));
              setFile(null);
              if (fileInput.current) fileInput.current.value = '';
              setApproved(false);
            })
          }
        >
          {t.upload}
        </Button>
        {manifest.tutorialPreamble && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                onSaved(
                  await updateBrandManifest(manifest.id, {
                    clearTutorialPreamble: true,
                  })
                );
              })
            }
          >
            {t.remove}
          </Button>
        )}
      </div>
    </Card>
  );
}
