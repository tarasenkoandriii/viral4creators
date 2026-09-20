'use client';

/**
 * Аудит-фикс (главная находка №1): backend POST/GET/DELETE /portfolio-
 * items работал с момента реализации Этапа 0, но ни одна страница не
 * вызывала его — Creator физически не мог добавить работу в портфолио
 * через сайт. Эта страница закрывает self-upload флоу целиком (ТЗ §9,
 * §11, §10 «Важно»): форма загрузки, список своих работ с статусом
 * модерации, удаление в любом статусе.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ApiError,
  createPortfolioItem,
  getMyPortfolioItems,
  PortfolioItemView,
  updatePortfolioItem,
  withdrawPortfolioItem,
} from '../../../lib/client-api';
import { useDictionary } from '../../../lib/dictionary-context';
import type { Locale } from '../../../lib/i18n';

export default function MyPortfolioPage({ params }: { params: { locale: Locale } }) {
  const { dict } = useDictionary();
  const [items, setItems] = useState<PortfolioItemView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needsQuiz, setNeedsQuiz] = useState(false);

  const [videoUrl, setVideoUrl] = useState('');
  const [title, setTitle] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [collectionTag, setCollectionTag] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Аудит-фикс: PATCH /portfolio-items/:id (смена подборки после
  // загрузки) существовал только на бэкенде — тег можно было задать
  // исключительно один раз, в момент создания, и никогда не поменять.
  const [editingTagFor, setEditingTagFor] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [rowError, setRowError] = useState<string | null>(null);

  const load = () => {
    getMyPortfolioItems()
      .then(setItems)
      .catch((e) => {
        // Аудит-фикс: раньше показывался текст «не получилось добавить
        // работу» даже при простом заходе на страницу без профиля вообще,
        // и форма загрузки всё равно отображалась — хотя отправить её
        // было заведомо нельзя. Теперь при отсутствии CreatorProfile
        // форма не рендерится вовсе, только ссылка на квиз.
        if (e instanceof ApiError && e.status === 403) setNeedsQuiz(true);
        else setLoadError(dict.errors.generic);
      });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createPortfolioItem({
        videoUrl,
        title,
        thumbnailUrl: thumbnailUrl || undefined,
        collectionTag: collectionTag || undefined,
      });
      setVideoUrl('');
      setTitle('');
      setThumbnailUrl('');
      setCollectionTag('');
      load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setError(dict.errors.notLoggedIn);
      else if (e instanceof ApiError && e.status === 403) setError(dict.myPortfolio.errorSubmit);
      else setError(dict.errors.generic);
    } finally {
      setSubmitting(false);
    }
  };

  const handleWithdraw = async (id: string) => {
    if (!window.confirm(dict.myPortfolio.withdrawConfirm)) return;
    setRowError(null);
    try {
      await withdrawPortfolioItem(id);
      load();
    } catch {
      // Аудит-фикс: раньше ошибка полностью проглатывалась — человек
      // видел, что работа никуда не делась, без единого объяснения.
      setRowError(dict.errors.generic);
    }
  };

  const handleSaveTag = async (id: string) => {
    setRowError(null);
    try {
      await updatePortfolioItem(id, { collectionTag: tagDraft || null });
      setEditingTagFor(null);
      load();
    } catch {
      // Аудит-фикс: то же самое — форма молча оставалась открытой без
      // единого слова о том, что пошло не так.
      setRowError(dict.myPortfolio.errorGeneric);
    }
  };

  const statusLabel = (status: PortfolioItemView['status']) =>
    status === 'PENDING'
      ? dict.myPortfolio.statusPending
      : status === 'PUBLISHED'
        ? dict.myPortfolio.statusPublished
        : dict.myPortfolio.statusRejected;

  if (needsQuiz) {
    return (
      <p className="mp-empty">
        {dict.errors.needsCreatorProfile} <Link href={`/${params.locale}/become-creator`}>{dict.dashboard.takeQuiz}</Link>
      </p>
    );
  }

  return (
    <>
      <h1>{dict.myPortfolio.heading}</h1>
      <p className="mp-hint">
        <Link href={`/${params.locale}/dashboard`}>{dict.dashboard.heading}</Link>
      </p>

      <h2>{dict.myPortfolio.addHeading}</h2>
      <form className="mp-form" onSubmit={(e) => void handleSubmit(e)}>
        <div className="mp-field">
          <label htmlFor="videoUrl">{dict.myPortfolio.videoUrlLabel}</label>
          <input id="videoUrl" type="url" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder={dict.myPortfolio.videoUrlPlaceholder} required />
        </div>
        <div className="mp-field">
          <label htmlFor="title">{dict.myPortfolio.titleLabel}</label>
          <input id="title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </div>
        <div className="mp-field">
          <label htmlFor="thumbnailUrl">{dict.myPortfolio.thumbnailLabel}</label>
          <input id="thumbnailUrl" type="url" value={thumbnailUrl} onChange={(e) => setThumbnailUrl(e.target.value)} />
        </div>
        <div className="mp-field">
          <label htmlFor="collectionTag">{dict.myPortfolio.collectionLabel}</label>
          <input
            id="collectionTag"
            type="text"
            value={collectionTag}
            onChange={(e) => setCollectionTag(e.target.value)}
            placeholder={dict.myPortfolio.collectionPlaceholder}
          />
        </div>
        {error && <p style={{ color: '#e05252' }}>{error}</p>}
        <button className="mp-cta" type="submit" disabled={submitting}>
          {submitting ? dict.myPortfolio.submitting : dict.myPortfolio.submit}
        </button>
      </form>

      <h2>{dict.profile.portfolioHeading}</h2>
      {loadError && <p style={{ color: '#e05252' }}>{loadError}</p>}
      {rowError && <p style={{ color: '#e05252' }}>{rowError}</p>}
      {items && items.length === 0 && <p className="mp-empty">{dict.myPortfolio.empty}</p>}
      {items && items.length > 0 && (
        <div className="mp-portfolio-grid">
          {items.map((item) => (
            <div key={item.id} className="mp-portfolio-item">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption -- собственный черновик работы, без озвучки на этом этапе */}
              <video src={item.videoUrl} controls playsInline poster={item.thumbnailUrl ?? undefined} />
              <div className="mp-portfolio-item-footer" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                <strong>{item.title}</strong>
                <span className="mp-pill">{statusLabel(item.status)}</span>
                {item.status === 'REJECTED' && item.rejectionReason && (
                  <span className="mp-hint">
                    {dict.myPortfolio.rejectionReasonPrefix} {item.rejectionReason}
                  </span>
                )}
                {editingTagFor === item.id ? (
                  <div style={{ display: 'flex', gap: 6, width: '100%' }}>
                    <input
                      type="text"
                      value={tagDraft}
                      onChange={(e) => setTagDraft(e.target.value)}
                      placeholder={dict.myPortfolio.collectionPlaceholder}
                      style={{ flex: 1 }}
                    />
                    <button type="button" className="mp-cta-secondary" onClick={() => void handleSaveTag(item.id)}>
                      {dict.settings.save}
                    </button>
                    <button type="button" className="mp-cta-secondary" onClick={() => setEditingTagFor(null)}>
                      {dict.myPortfolio.cancel}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="mp-cta-secondary"
                    onClick={() => {
                      setEditingTagFor(item.id);
                      setTagDraft(item.collectionTag ?? '');
                      setRowError(null);
                    }}
                  >
                    {item.collectionTag ? `#${item.collectionTag}` : dict.myPortfolio.addTagButton}
                  </button>
                )}
                <button type="button" className="mp-cta-secondary" onClick={() => void handleWithdraw(item.id)}>
                  {dict.myPortfolio.withdraw}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
