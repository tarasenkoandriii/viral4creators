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
import { aspectRatioNote } from '../lib/aspect-ratio';

export function VideoProcessingStatus({
  video,
  dict,
}: {
  video: GeneratedVideo;
  dict: Dictionary;
}) {
  const note = aspectRatioNote(video);
  const errorSuffix = video.postError ? ` (${video.postError})` : '';
  return (
    <>
      {video.aspectRatio && (
        <p className="mt-3 text-xs text-silver-400">
          {dict.generationWizard.formatLabel.replace(
            '{{ratio}}',
            video.aspectRatio
          )}
          {/* §15.4/§16.1: постобработка идёт после того, как ролик уже
              отдан, поэтому здесь честные состояния, а не одно обещание
              «появится позже». Какое именно — решает чистая
              `aspectRatioNote` (сквозной аудит 27.09.2026, Д-4): здесь
              же это было записано четырьмя условиями в JSX, и одно из
              них печатало «обрезано из .» с пустым форматом. */}
          {note.kind === 'reframePending' && (
            <>
              {' '}
              {dict.generationWizard.reframePendingNote
                .replace('{{rendered}}', note.rendered)
                .replace('{{target}}', note.target)}
            </>
          )}
          {note.kind === 'croppedFrom' && (
            <>
              {' '}
              {dict.generationWizard.croppedFromNote.replace(
                '{{rendered}}',
                note.rendered
              )}
            </>
          )}
          {note.kind === 'postFailed' && (
            <>
              {' '}
              {dict.generationWizard.postFailedNote
                .replace('{{rendered}}', note.rendered)
                .replace('{{errorSuffix}}', errorSuffix)}
            </>
          )}
          {note.kind === 'postFailedNoSource' && (
            <>
              {' '}
              {dict.generationWizard.postFailedNoteNoSource.replace(
                '{{errorSuffix}}',
                errorSuffix
              )}
            </>
          )}
          {note.kind === 'reframeSkipped' && (
            <>
              {' '}
              {dict.generationWizard.reframeSkippedNote
                .replace('{{rendered}}', note.rendered)
                .replace('{{target}}', note.target)}
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
      {/* Фон при дубляже (27.09.2026). Показываем ТОЛЬКО неудачу и
          ТОЛЬКО одной нейтральной строкой: причина у трёх исходов
          разная (выключатель оператора, ненастроенный провайдер, сбой
          разделения), а для человека они означают ровно одно — под
          голосом тишина. Называть ему внутреннюю настройку незачем, а
          удача в объявлении не нуждается: её слышно. */}
      {video.voiceMode === 'dub' &&
        video.backgroundStatus &&
        video.backgroundStatus !== 'kept' && (
          <p className="mt-1 text-xs text-silver-400">
            {dict.generationWizard.backgroundLost}
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
