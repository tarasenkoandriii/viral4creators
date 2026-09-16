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
 *
 * Удаление (этап 88.2, прямой запрос владельца продукта): кнопка в
 * правом верхнем углу, тот же приём (`ScreenHeader`'s `action`), что и
 * «Удалить проект» на `ProjectScreen` — тем же значком `Trash2`, для
 * единого языка иконок по приложению (буквальный «крестик» здесь читался
 * бы как «закрыть», а не «удалить»).
 */

import { useState } from 'react';
import { Clapperboard, Trash2 } from 'lucide-react';
import {
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  LockedNote,
  Spinner,
} from '../../components/ui';
import { useFeature } from '../../lib/plan-context';
import { useI18n } from '../../lib/i18n-context';
import { navigate, routes } from '../../lib/router';
import { ScreenHeader, LoadError } from '../projects/shared';
import { errorMessage } from '../../services/projects-api';
import { deletePostprodVideo } from '../../services/postprod-api';
import { VideoPlayer } from '../../components/VideoPlayer';
import { VideoProcessingStatus } from '../../components/VideoProcessingStatus';
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
    reload,
  } = usePostprodVideo(sessionId);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // «Умный» алерт удаления (этап 89): у Session нет превью счётчиков
  // (все её связи в БД — SetNull, каскадить нечему, см. doc/
  // PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md), поэтому диалог сразу
  // показывает честный текст без запроса счётчиков.
  const [confirmOpen, setConfirmOpen] = useState(false);

  const onConfirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deletePostprodVideo(sessionId);
      setConfirmOpen(false);
      navigate(routes.postprod(), true);
    } catch (e) {
      setDeleteError(errorMessage(e));
      setConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  };

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
        {/* Найдено доп. аудитом (LOW): раньше без onRetry — единственный
            выход был «назад» на список, хотя сетевая икота часто чинится
            повторной попыткой на месте (тот же приём, что PostprodScreen
            уже даёт своей LoadError). */}
        <LoadError error={error} onRetry={reload} />
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
        action={
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={14} />}
            onClick={() => setConfirmOpen(true)}
            aria-label={dict.postprodVideoScreen.deleteAriaLabel}
          />
        }
      />

      {deleteError && (
        <Alert tone="error" onDismiss={() => setDeleteError(null)}>
          {deleteError}
        </Alert>
      )}

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
                  // Найдено при доп. аудите: раньше безусловно «Оригинал
                  // Veo» независимо от video.provider — на Grok-роликах
                  // подпись называла чужого провайдера (тот же класс
                  // бага, что GenerationWizard уже чинил для
                  // busy-заголовков, см. её доккомментарий).
                  label:
                    video.provider === 'grok'
                      ? dict.generationWizard.originalGrokLabel
                      : dict.generationWizard.originalVeoLabel,
                  url: video.renderedUrl,
                },
              ]
            : undefined
        }
      />

      {/* Найдено доп. аудитом (HIGH, этап 88) — см. доккомментарий
          VideoProcessingStatus: раньше этот экран не показывал НИЧЕГО
          про провал кропа/озвучки/субтитров, если только сам
          RevoicePanel не решал показать свой единственный алерт (а он
          вообще не рендерится при voiceMode === 'veo'). Независим от
          RevoicePanel специально — не должен зависеть от его условия
          рендера. */}
      <VideoProcessingStatus video={video} dict={dict} />

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

      <ConfirmDialog
        open={confirmOpen}
        title={dict.deleteConfirm.sessionTitle}
        busy={deleting}
        onConfirm={() => void onConfirmDelete()}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>{dict.deleteConfirm.sessionBody}</p>
      </ConfirmDialog>
    </div>
  );
}
