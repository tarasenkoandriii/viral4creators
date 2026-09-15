/**
 * PostprodVideoScreen (#/postprod/:sessionId) — один готовый ролик вне
 * мастера генерации (этап 88). Здесь живёт «весь комплект
 * постпродакшена», перенесённый из финального экрана
 * `GenerationWizard` (см. его доккомментарий у соответствующего блока):
 * переозвучка, экспорт, публикация и шаринг. Не перенесены (остались в
 * мастере) `AuditPanel`/`SoundCheckPanel` — они умеют откатить мастер на
 * шаг промпта и перегенерировать ролик (`onFixApplied` →
 * `startRevision`), а у уже завершённой сессии вне мастера «шага, куда
 * вернуться» просто нет — и `CatalogBatchPanel`/`AbTestPanel` — они
 * привязаны к конкретному проекту (`projectId`), тогда как этот экран
 * открывает ЛЮБОЙ готовый ролик пользователя, в том числе без проекта.
 *
 * Состояние — не `useWorkflow` (тот жёстко завязан на один
 * localStorage-активный sessionId, см. usePostprodVideo), а лёгкий
 * `usePostprodVideo`.
 */

import { Clapperboard } from 'lucide-react';
import { EmptyState, LockedNote, Spinner } from '../../components/ui';
import { useFeature } from '../../lib/plan-context';
import { useI18n } from '../../lib/i18n-context';
import { routes } from '../../lib/router';
import { ScreenHeader, LoadError } from '../projects/shared';
import { VideoPlayer } from '../../components/VideoPlayer';
import { usePostprodVideo } from '../../hooks/usePostprodVideo';
import { RevoicePanel } from '../generation/RevoicePanel';
import { ExportPanel } from '../generation/ExportPanel';
import { PublishPanel } from '../generation/PublishPanel';
import { ShareVideoPanel } from '../generation/ShareVideoPanel';

export function PostprodVideoScreen({ sessionId }: { sessionId: string }) {
  const { dict } = useI18n();
  const publication = useFeature('publication');
  const {
    video,
    voiceoverScript,
    snapshot,
    productName,
    productDescription,
    productCategory,
    loading,
    error,
    reVoice,
    setSnapshot,
  } = usePostprodVideo(sessionId);

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size={26} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="animate-fadeIn">
        <ScreenHeader
          title={dict.postprodVideoScreen.untitledTitle}
          back={routes.postprod()}
        />
        <LoadError error={error} />
      </div>
    );
  }

  if (!video?.downloadUrl) {
    return (
      <div className="animate-fadeIn">
        <ScreenHeader
          title={dict.postprodVideoScreen.untitledTitle}
          back={routes.postprod()}
        />
        <EmptyState
          icon={<Clapperboard size={28} />}
          title={dict.postprodVideoScreen.notFoundTitle}
          hint={dict.postprodVideoScreen.notFoundHint}
        />
      </div>
    );
  }

  return (
    <div className="animate-fadeIn space-y-4">
      <ScreenHeader
        title={productName || dict.postprodVideoScreen.untitledTitle}
        back={routes.postprod()}
      />

      <VideoPlayer
        videoUrl={video.downloadUrl}
        title={productName || dict.postprodVideoScreen.untitledTitle}
        downloadUrl={video.downloadUrl}
        variants={
          video.postStatus === 'complete' && video.renderedUrl
            ? [
                {
                  key: 'final',
                  label: dict.generationWizard.afterProcessingLabel,
                  url: video.downloadUrl,
                },
                {
                  key: 'source',
                  label: dict.generationWizard.originalVeoLabel,
                  url: video.renderedUrl,
                },
              ]
            : undefined
        }
      />

      <RevoicePanel
        sessionId={sessionId}
        video={video}
        voiceoverScript={voiceoverScript}
        snapshot={snapshot}
        onReVoice={reVoice}
        onBrandUpdated={setSnapshot}
      />

      <ExportPanel sessionId={sessionId} video={video} />

      {!publication.allowed && !publication.loading && (
        <LockedNote
          title={dict.generationWizard.publishLockedTitle}
          lock={publication.lock}
        >
          {dict.generationWizard.publishLockedBody}
        </LockedNote>
      )}
      {publication.allowed && video.generatedVideoId && (
        <PublishPanel
          sessionId={sessionId}
          generatedVideoId={video.generatedVideoId}
          productName={productName}
          productDescription={productDescription}
          category={productCategory}
        />
      )}
      {publication.allowed && video.generatedVideoId && (
        <ShareVideoPanel
          sessionId={sessionId}
          generatedVideoId={video.generatedVideoId}
          productName={productName}
        />
      )}
    </div>
  );
}
