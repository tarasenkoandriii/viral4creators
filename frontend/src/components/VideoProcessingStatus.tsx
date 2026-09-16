/**
 * VideoProcessingStatus — три независимых исхода одного и того же прохода
 * ffmpeg (кроп кадра / своя озвучка / жёстко вшитые субтитры, §15.4/§16.1,
 * §15, этап 67) для уже сгенерированного ролика. Раньше жила инлайн внутри
 * `GenerationWizard`'а шага «complete» (см. её доккомментарий у блока,
 * перенесённого сюда без изменения логики или текстов).
 *
 * Найдено доп. аудитом (HIGH, этап 88): при переносе финального экрана в
 * `PostprodVideoScreen` этот блок не перенесли вместе с ним — там остался
 * только `RevoicePanel`'ов алерт про `postStatus === 'failed'`, который (а)
 * не рендерится вовсе для `voiceMode === 'veo'` (RevoicePanel возвращает
 * null), и (б) не говорит НИЧЕГО о `voiceStatus === 'failed'` /
 * `subtitleStatus === 'failed'`, когда `postStatus === 'complete'` —
 * ролик с кропом всё сделал, а озвучка/субтитры молча провалились. Ролик,
 * открытый из вкладки «Постпрод» (единственное место, где он теперь
 * доступен), показывал плеер без единого слова о том, что купленная
 * озвучка не применилась. Вынесено в общий компонент, чтобы у мастера
 * генерации и у вкладки «Постпрод» не могло разойтись одно и то же
 * условие в двух копиях.
 */
import type { Dictionary } from '../lib/get-dictionary';
import type { GeneratedVideo } from '../services/api';

export function VideoProcessingStatus({
  video,
  dict,
}: {
  video: GeneratedVideo;
  dict: Dictionary;
}) {
  return (
    <>
      {video.aspectRatio && (
        <p className="mt-3 text-xs text-silver-400">
          {dict.generationWizard.formatLabel.replace(
            '{{ratio}}',
            video.aspectRatio
          )}
          {/* §15.4/§16.1: постобработка идёт после того, как ролик уже
              отдан, поэтому здесь четыре разных честных состояния, а не
              одно обещание «появится позже». */}
          {video.postStatus === 'pending' && video.reframePending && (
            <>
              {' '}
              {dict.generationWizard.reframePendingNote
                .replace('{{rendered}}', video.renderedAspectRatio ?? '')
                .replace('{{target}}', video.aspectRatio)}
            </>
          )}
          {video.postStatus === 'complete' &&
            video.renderedAspectRatio !== video.aspectRatio && (
              <>
                {' '}
                {dict.generationWizard.croppedFromNote.replace(
                  '{{rendered}}',
                  video.renderedAspectRatio ?? ''
                )}
              </>
            )}
          {video.postStatus === 'failed' && (
            <>
              {' '}
              {dict.generationWizard.postFailedNote
                .replace('{{rendered}}', video.renderedAspectRatio ?? '')
                .replace(
                  '{{errorSuffix}}',
                  video.postError ? ` (${video.postError})` : ''
                )}
            </>
          )}
          {video.postStatus === 'skipped' &&
            video.reframePending &&
            video.renderedAspectRatio && (
              <>
                {' '}
                {dict.generationWizard.reframeSkippedNote
                  .replace('{{rendered}}', video.renderedAspectRatio)
                  .replace('{{target}}', video.aspectRatio)}
              </>
            )}
        </p>
      )}
      {/* Б-2.7: отказ постобработки по дневному лимиту или блокировке
          приходит в `postError`, но не показывался НИГДЕ, если резать
          было нечего: при родном формате все ветки выше молчат, а
          `voiceStatus` в этом случае не выставляется вовсе — строка
          «Озвучка:» оставалась пустой. Человек видел ролик со звуком
          модели и ни слова о причине. */}
      {video.postStatus === 'skipped' &&
        video.postError &&
        !video.reframePending && (
          <p className="mt-1 text-xs text-amber-500">
            {dict.generationWizard.processingSkippedNote.replace(
              '{{error}}',
              video.postError
            )}
          </p>
        )}
      {/* §15: озвучка — отдельное состояние. «Не подключено» и
          «сломалось» показаны по-разному: первое не повод идти
          разбираться, второе — повод. */}
      {video.voiceMode && video.voiceMode !== 'veo' && (
        <p className="mt-1 text-xs text-silver-400">
          {dict.generationWizard.voiceLabel}{' '}
          {/* Постобработка могла не начаться вовсе (лимит, блокировка) —
              тогда статуса озвучки нет, и молчать здесь нельзя (Б-2.7). */}
          {!video.voiceStatus &&
            (video.postStatus === 'skipped' || video.postStatus === 'failed') &&
            `${dict.generationWizard.voiceNotDone.replace(
              '{{reason}}',
              video.postError ?? dict.generationWizard.noReasonDefault
            )} ${dict.generationWizard.voiceModelSoundNote}`}
          {video.voiceStatus === 'synthesized' &&
            (video.postStatus === 'pending'
              ? dict.generationWizard.voiceRecordedApplying
              : video.postStatus === 'complete'
                ? video.voiceMode === 'dub'
                  ? dict.generationWizard.voiceOwnReplace
                  : dict.generationWizard.voiceOwnOverlay
                : dict.generationWizard.voiceRecorded)}
          {/* Причина здесь уже готовая фраза («озвучка на этом стенде не
              подключена», «текста озвучки нет») — приписывать к ней свою
              значит повторяться. */}
          {video.voiceStatus === 'skipped' &&
            `${video.voiceError ?? dict.generationWizard.voiceNotConnectedDefault}. ${dict.generationWizard.voiceModelSoundNote}`}
          {video.voiceStatus === 'failed' &&
            `${dict.generationWizard.voiceFailed.replace(
              '{{reason}}',
              video.voiceError ?? dict.generationWizard.noReasonDefault
            )} ${dict.generationWizard.voiceModelSoundNote}`}
        </p>
      )}
      {/* Этап 67: субтитры — третий ингредиент того же прохода ffmpeg, что
          кроп и голос, но третий, независимый статус (та же логика, что у
          голоса — провал сборки субтитров не отменяет ни кроп, ни звук).
          Абзац скрыт целиком, если бренд субтитры не заказывал
          (subtitlesMode !== 'on'). */}
      {video.subtitlesMode === 'on' && (
        <p className="mt-1 text-xs text-silver-400">
          {dict.generationWizard.subtitlesLabel}{' '}
          {/* Постобработка могла не начаться вовсе (лимит, блокировка) —
              тогда статуса субтитров нет, и молчать здесь нельзя, по той
              же причине, что и у голоса. */}
          {!video.subtitleStatus &&
            (video.postStatus === 'skipped' || video.postStatus === 'failed') &&
            dict.generationWizard.subtitlesSkipped.replace(
              '{{reason}}',
              video.postError ?? dict.generationWizard.noReasonDefault
            )}
          {video.subtitleStatus === 'burned' &&
            dict.generationWizard.subtitlesBurned}
          {video.subtitleStatus === 'skipped' &&
            dict.generationWizard.subtitlesSkipped.replace(
              '{{reason}}',
              video.subtitleError ?? dict.generationWizard.noReasonDefault
            )}
          {video.subtitleStatus === 'failed' &&
            dict.generationWizard.subtitlesFailed.replace(
              '{{reason}}',
              video.subtitleError ?? dict.generationWizard.noReasonDefault
            )}
        </p>
      )}
    </>
  );
}
