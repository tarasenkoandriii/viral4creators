'use client';

/**
 * Аудит-фикс (главная находка №4): ТЗ §21.8 явно обещал «переключатель
 * «принимаю заказы» в настройках профиля» — PATCH /creator-profiles/me
 * существовал на бэкенде с самого начала, но ни одна страница его не
 * вызывала. Обратимость решения стать исполнителем была декларативной,
 * не реальной. Эта страница закрывает её: toggle, ниши, bio, цены,
 * vanity-ссылка (§20 №1), доп. контакт.
 *
 * Соцсети (CreatorSocialLink) отсюда пока не редактируются — при квизе
 * их можно задать, но полноценный редактор списка (добавить/удалить)
 * оставлен на следующий проход, чтобы не раздувать эту форму.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ApiError,
  CreatorProfileFullView,
  getMyCreatorProfile,
  updateMyCreatorProfile,
} from '../../../lib/client-api';
import { useDictionary } from '../../../lib/dictionary-context';
import type { Locale } from '../../../lib/i18n';

export default function SettingsPage({ params }: { params: { locale: Locale } }) {
  const { dict } = useDictionary();
  const [profile, setProfile] = useState<CreatorProfileFullView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [isAcceptingOrders, setIsAcceptingOrders] = useState(true);
  const [niches, setNiches] = useState('');
  const [bio, setBio] = useState('');
  const [slug, setSlug] = useState('');
  const [priceRangeMin, setPriceRangeMin] = useState('');
  const [priceRangeMax, setPriceRangeMax] = useState('');
  const [contactHandle, setContactHandle] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getMyCreatorProfile()
      .then((p) => {
        setProfile(p);
        setIsAcceptingOrders(p.isAcceptingOrders);
        setNiches(p.niches.join(', '));
        setBio(p.bio ?? '');
        setSlug(p.slug ?? '');
        setPriceRangeMin(p.priceRangeMin != null ? String(p.priceRangeMin) : '');
        setPriceRangeMax(p.priceRangeMax != null ? String(p.priceRangeMax) : '');
        setContactHandle(p.contactHandle ?? '');
      })
      .catch((e) => setLoadError(e instanceof ApiError && e.status === 404 ? null : dict.errors.generic));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const updated = await updateMyCreatorProfile({
        isAcceptingOrders,
        niches: niches.split(',').map((n) => n.trim()).filter(Boolean),
        // Аудит-фикс: undefined в PATCH означает «не трогать поле», а не
        // «очистить». Пустое поле формы — это явное намерение убрать
        // значение, поэтому здесь null, а не undefined; бэкенд это уже
        // поддерживал (@IsOptional() пропускает null), не хватало только
        // прислать его с этой стороны.
        bio: bio || null,
        slug: slug || null,
        priceRangeMin: priceRangeMin ? Number(priceRangeMin) : null,
        priceRangeMax: priceRangeMax ? Number(priceRangeMax) : null,
        contactHandle: contactHandle || null,
      });
      setProfile(updated);
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setError(dict.settings.errorSlugTaken);
      else if (e instanceof ApiError && e.status === 401) setError(dict.errors.notLoggedIn);
      else setError(dict.settings.errorSave);
    } finally {
      setSaving(false);
    }
  };

  if (loadError) return <p style={{ color: '#e05252' }}>{loadError}</p>;

  if (!profile) {
    return (
      <p className="mp-empty">
        {dict.dashboard.errorPrefix} <Link href={`/${params.locale}/become-creator`}>{dict.dashboard.takeQuiz}</Link>
      </p>
    );
  }

  return (
    <>
      <h1>{dict.settings.heading}</h1>
      <p className="mp-hint">
        <Link href={`/${params.locale}/my-portfolio`}>{dict.settings.myPortfolioLink}</Link>
      </p>

      <form className="mp-form" onSubmit={(e) => void handleSubmit(e)}>
        <div className="mp-field">
          <label>
            <input type="checkbox" checked={isAcceptingOrders} onChange={(e) => setIsAcceptingOrders(e.target.checked)} />{' '}
            {dict.settings.acceptingOrdersLabel}
          </label>
        </div>

        <div className="mp-field">
          <label htmlFor="slug">{dict.settings.slugLabel}</label>
          <input id="slug" type="text" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={dict.settings.slugPlaceholder} />
        </div>

        <div className="mp-field">
          <label htmlFor="niches">{dict.settings.nichesLabel}</label>
          <input id="niches" type="text" value={niches} onChange={(e) => setNiches(e.target.value)} />
        </div>

        <div className="mp-field">
          <label htmlFor="bio">{dict.settings.bioLabel}</label>
          <textarea id="bio" rows={3} value={bio} onChange={(e) => setBio(e.target.value)} />
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <div className="mp-field" style={{ flex: 1 }}>
            <label htmlFor="priceMin">{dict.settings.priceMinLabel}</label>
            <input id="priceMin" type="number" min={0} value={priceRangeMin} onChange={(e) => setPriceRangeMin(e.target.value)} />
          </div>
          <div className="mp-field" style={{ flex: 1 }}>
            <label htmlFor="priceMax">{dict.settings.priceMaxLabel}</label>
            <input id="priceMax" type="number" min={0} value={priceRangeMax} onChange={(e) => setPriceRangeMax(e.target.value)} />
          </div>
        </div>

        <div className="mp-field">
          <label htmlFor="contactHandle">{dict.settings.contactLabel}</label>
          <input id="contactHandle" type="text" value={contactHandle} onChange={(e) => setContactHandle(e.target.value)} />
        </div>

        {error && <p style={{ color: '#e05252' }}>{error}</p>}

        <button className="mp-cta" type="submit" disabled={saving}>
          {saving ? dict.settings.saving : saved ? dict.settings.saved : dict.settings.save}
        </button>
      </form>
    </>
  );
}
