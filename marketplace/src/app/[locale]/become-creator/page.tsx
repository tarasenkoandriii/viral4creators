'use client';

/**
 * Квиз исполнителя (ТЗ §21.8) — явное предложение, явное согласие,
 * минимум одна публичная соцсеть. Обратимо в любой момент.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, submitCreatorQuiz } from '../../../lib/client-api';
import { useDictionary } from '../../../lib/dictionary-context';
import type { Locale } from '../../../lib/i18n';

const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'other'] as const;

export default function BecomeCreatorPage({ params }: { params: { locale: Locale } }) {
  const { dict } = useDictionary();
  const router = useRouter();
  const [niches, setNiches] = useState('');
  const [bio, setBio] = useState('');
  const [contactHandle, setContactHandle] = useState('');
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]>('instagram');
  const [socialUrl, setSocialUrl] = useState('');
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!consent) {
      setError(dict.becomeCreator.errorConsent);
      return;
    }
    if (!socialUrl.trim()) {
      setError(dict.becomeCreator.errorNoSocial);
      return;
    }
    setSubmitting(true);
    try {
      await submitCreatorQuiz({
        niches: niches.split(',').map((n) => n.trim()).filter(Boolean),
        bio: bio || undefined,
        contactHandle: contactHandle || undefined,
        socialLinks: [{ platform, url: socialUrl }],
        consent,
      });
      router.push(`/${params.locale}`);
    } catch (e) {
      // Аудит-фикс: раньше всегда показывался один и тот же текст «войдите
      // через Telegram», даже если реальная причина — уже существующий
      // профиль (409), где этот совет не помогает.
      if (e instanceof ApiError && e.status === 401) setError(dict.errors.notLoggedIn);
      else if (e instanceof ApiError && e.status === 409) setError(dict.errors.conflict);
      else setError(dict.becomeCreator.errorSubmit);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <h1>{dict.becomeCreator.heading}</h1>
      <p className="mp-hint">{dict.becomeCreator.hint}</p>

      <form className="mp-form" onSubmit={(e) => void handleSubmit(e)}>
        <div className="mp-field">
          <label htmlFor="niches">{dict.becomeCreator.nichesLabel}</label>
          <input id="niches" type="text" value={niches} onChange={(e) => setNiches(e.target.value)} placeholder={dict.becomeCreator.nichesPlaceholder} required />
        </div>

        <div className="mp-field">
          <label htmlFor="bio">{dict.becomeCreator.bioLabel}</label>
          <textarea id="bio" rows={3} value={bio} onChange={(e) => setBio(e.target.value)} />
        </div>

        <div className="mp-field">
          <label htmlFor="platform">{dict.becomeCreator.platformLabel}</label>
          <select id="platform" value={platform} onChange={(e) => setPlatform(e.target.value as typeof platform)}>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div className="mp-field">
          <label htmlFor="socialUrl">{dict.becomeCreator.urlLabel}</label>
          <input id="socialUrl" type="url" value={socialUrl} onChange={(e) => setSocialUrl(e.target.value)} placeholder={dict.becomeCreator.urlPlaceholder} required />
        </div>

        <div className="mp-field">
          <label htmlFor="contactHandle">{dict.becomeCreator.contactLabel}</label>
          <input
            id="contactHandle"
            type="text"
            value={contactHandle}
            onChange={(e) => setContactHandle(e.target.value)}
            placeholder={dict.becomeCreator.contactPlaceholder}
          />
        </div>

        <div className="mp-field">
          <label>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> {dict.becomeCreator.consentLabel}
          </label>
        </div>

        {error && <p style={{ color: '#e05252' }}>{error}</p>}

        <button className="mp-cta" type="submit" disabled={submitting}>
          {submitting ? dict.becomeCreator.submitting : dict.becomeCreator.submit}
        </button>
      </form>
    </>
  );
}
