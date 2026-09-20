'use client';

/**
 * Мастер брендбука (ТЗ §21.7) — переиспользует существующий backend/src/
 * modules/brand-manifest как есть. Фото персонажей/сцен не подключены —
 * отдельный presigned-Blob флоу, сознательно не часть этого прохода.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { addBrandCharacter, addBrandScene, ApiError, createBrandManifest, VoiceMode } from '../../../lib/client-api';
import { useDictionary } from '../../../lib/dictionary-context';
import type { Locale } from '../../../lib/i18n';

const VOICE_MODES: VoiceMode[] = ['veo', 'voiceover', 'dub'];

interface NamedItem {
  label: string;
  description: string;
}

export default function BrandBookPage({ params }: { params: { locale: Locale } }) {
  const { dict } = useDictionary();
  const router = useRouter();
  const [step, setStep] = useState(0);

  const [title, setTitle] = useState('');
  const [styleNotes, setStyleNotes] = useState('');
  const [voiceNotes, setVoiceNotes] = useState('');
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('veo');
  const [characters, setCharacters] = useState<NamedItem[]>([{ label: '', description: '' }]);
  const [scenes, setScenes] = useState<NamedItem[]>([{ label: '', description: '' }]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const steps = dict.brandBook.steps;
  const canGoNext = step === 0 ? title.trim().length > 0 : true;

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const manifest = await createBrandManifest({
        title,
        styleNotes: styleNotes || undefined,
        voiceNotes: voiceNotes || undefined,
        voiceMode,
      });
      for (const c of characters) {
        if (c.label.trim()) await addBrandCharacter(manifest.id, { label: c.label, description: c.description || undefined });
      }
      for (const s of scenes) {
        if (s.label.trim()) await addBrandScene(manifest.id, { label: s.label, description: s.description || undefined });
      }
      setCreatedId(manifest.id);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? dict.errors.notLoggedIn : dict.brandBook.errorSubmit);
    } finally {
      setSubmitting(false);
    }
  };

  if (createdId) {
    return (
      <>
        <h1>{dict.brandBook.doneHeading}</h1>
        <p className="mp-hint">{dict.brandBook.doneHint}</p>
        <button className="mp-cta" onClick={() => router.push(`/${params.locale}/brief?brandManifestId=${createdId}`)}>
          {dict.brandBook.createBriefButton}
        </button>
      </>
    );
  }

  return (
    <>
      <h1>{dict.brandBook.heading}</h1>
      <p className="mp-hint">
        {dict.brandBook.stepPrefix} {step + 1} {dict.brandBook.stepOf} {steps.length}: {steps[step]}
      </p>

      <div className="mp-form">
        {step === 0 && (
          <div className="mp-field">
            <label htmlFor="title">{dict.brandBook.titleLabel}</label>
            <input id="title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
        )}

        {step === 1 && (
          <div className="mp-field">
            <label htmlFor="styleNotes">{dict.brandBook.styleLabel}</label>
            <textarea id="styleNotes" rows={5} value={styleNotes} onChange={(e) => setStyleNotes(e.target.value)} placeholder={dict.brandBook.stylePlaceholder} />
          </div>
        )}

        {step === 2 && (
          <>
            <div className="mp-field">
              <label htmlFor="voiceMode">{dict.brandBook.voiceModeLabel}</label>
              <select id="voiceMode" value={voiceMode} onChange={(e) => setVoiceMode(e.target.value as VoiceMode)}>
                {VOICE_MODES.map((value) => (
                  <option key={value} value={value}>
                    {dict.brandBook.voiceModes[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="mp-field">
              <label htmlFor="voiceNotes">{dict.brandBook.voiceNotesLabel}</label>
              <textarea id="voiceNotes" rows={4} value={voiceNotes} onChange={(e) => setVoiceNotes(e.target.value)} />
            </div>
          </>
        )}

        {step === 3 && (
          <NamedItemsEditor
            title={dict.brandBook.charactersHeading}
            items={characters}
            setItems={setCharacters}
            labelPlaceholder={dict.brandBook.charactersLabelPlaceholder}
            descPlaceholder={dict.brandBook.charactersDescPlaceholder}
            addMoreLabel={dict.brandBook.addMore}
          />
        )}

        {step === 4 && (
          <NamedItemsEditor
            title={dict.brandBook.scenesHeading}
            items={scenes}
            setItems={setScenes}
            labelPlaceholder={dict.brandBook.scenesLabelPlaceholder}
            descPlaceholder={dict.brandBook.scenesDescPlaceholder}
            addMoreLabel={dict.brandBook.addMore}
          />
        )}

        {error && <p style={{ color: '#e05252' }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <button type="button" className="mp-cta-secondary" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            {dict.brandBook.back}
          </button>
          {step < steps.length - 1 ? (
            <button type="button" className="mp-cta" disabled={!canGoNext} onClick={() => setStep((s) => Math.min(steps.length - 1, s + 1))}>
              {dict.brandBook.next}
            </button>
          ) : (
            <button type="button" className="mp-cta" disabled={submitting} onClick={() => void handleSubmit()}>
              {submitting ? dict.brandBook.saving : dict.brandBook.save}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function NamedItemsEditor({
  title,
  items,
  setItems,
  labelPlaceholder,
  descPlaceholder,
  addMoreLabel,
}: {
  title: string;
  items: NamedItem[];
  setItems: (v: NamedItem[]) => void;
  labelPlaceholder: string;
  descPlaceholder: string;
  addMoreLabel: string;
}) {
  return (
    <div className="mp-field">
      <label>{title}</label>
      {items.map((item, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          <input
            type="text"
            placeholder={labelPlaceholder}
            value={item.label}
            onChange={(e) => setItems(items.map((it, idx) => (idx === i ? { ...it, label: e.target.value } : it)))}
          />
          <textarea
            rows={2}
            placeholder={descPlaceholder}
            value={item.description}
            onChange={(e) => setItems(items.map((it, idx) => (idx === i ? { ...it, description: e.target.value } : it)))}
          />
        </div>
      ))}
      <button type="button" className="mp-cta-secondary" onClick={() => setItems([...items, { label: '', description: '' }])}>
        {addMoreLabel}
      </button>
    </div>
  );
}
