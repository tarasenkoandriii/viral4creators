/**
 * Карточка «Музыка» (фича №4) блока «Характер ролика», вместе с
 * загрузкой своей музыки (`MusicUploader`) и прослушиванием трека
 * библиотеки (`LibraryPreviewAudio`) — они нужны только ей.
 *
 * Вынесено из `GreetingVideoWizard.tsx` (файл перерос 3700 строк):
 * мастер держит только общий экран, степпер и загрузку сессии, а
 * каждый шаг живёт в своём файле, чтобы правка одного шага не
 * требовала листать остальные. Поведение и `data-qa` — без изменений.
 */

import { useState, useEffect, useRef } from 'react';
import { Music, Upload } from 'lucide-react';
import {
  Card,
  CardHeader,
  Button,
  Alert,
  Input,
  Field,
} from '../../../components/ui';
import { useI18n } from '../../../lib/i18n-context';
import { errorMessage } from '../../../services/projects-api';
import { mediaPlaybackRef } from '../../../lib/media-playback';
import {
  getGreetingMusic,
  selectGreetingMusic,
  searchGreetingMusicLibrary,
  selectGreetingMusicFromLibrary,
  GREETING_MUSIC_ACCEPT,
  MAX_GREETING_MUSIC_BYTES,
  uploadGreetingMusic,
  linkGreetingMusic,
} from '../../../services/greeting-api';
import type { GreetingMusicView } from '../../../types/project';
import type { GreetingRegisterRules } from '../../../lib/greeting-policy';
import { HelpButton } from '../HelpSheet';
import {
  SESSION_VOICE_TARGETS,
  planMusicVoice,
  refusalLines,
  needsSave,
  saveEffect,
} from '../../../lib/voice-fields';
import { useVoiceFieldApplier } from '../../voice/voice-commands';
import {
  musicSummary,
  showOwnMusicWarning,
} from '../../../lib/greeting-character';
import {
  useSessionVoiceTexts,
  describeSessionValue,
} from '../../voice/greeting-session-voice';

// ── Музыкальная подложка (фича №4) ───────────────────────────────────────

/**
 * Музыка под поздравление.
 *
 * Секции нет вовсе, пока каталог пуст: темы — лицензированные файлы,
 * их загружает владелец продукта, и до первой загруженной темы
 * показывать тут нечего. Это же и путь выката — код уезжает в прод
 * тёмным.
 *
 * Список тем приходит уже отфильтрованным по поводу сессии: у
 * соболезнования и дня рождения общей подложки не бывает ни при каком
 * тоне.
 */
/**
 * Предпрослушка трека библиотеки. Играющий вслух трек микрофон помощника
 * не пишет как речь (`media-playback.ts`, контракт P-раунда п. 5). Свой
 * компонент — потому что треков в списке много, а `mediaPlaybackRef`
 * держит один элемент: общий реф на все снимал бы регистрацию соседей.
 */
function LibraryPreviewAudio({ src }: { src: string }) {
  const [playbackRef] = useState(() => mediaPlaybackRef());
  return (
    <audio
      ref={playbackRef}
      controls
      preload="none"
      src={src}
      className="h-8 max-w-[180px]"
    />
  );
}

export function MusicThemeStep({
  sessionId,
  rules = null,
  onSummary,
}: {
  sessionId: string;
  /** Правила регистра брифа; `null` — таблица не загрузилась. */
  rules?: GreetingRegisterRules | null;
  onSummary?: (value: string | null) => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [music, setMusic] = useState<GreetingMusicView | null>(null);
  // Прочитано ли состояние с сервера. После ошибки `music` — запасная
  // пустая витрина для экрана, и «Музыка: нет» по ней было бы
  // выдумкой: тема могла быть выбрана (аудит этапа D).
  const [musicLoaded, setMusicLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getGreetingMusic(sessionId)
      .then((m) => {
        if (!alive) return;
        setMusic(m);
        setMusicLoaded(true);
      })
      // Запрос не прошёл — показываем пустую витрину, но БЕЗ блока
      // поиска: настроена библиотека или нет, мы в этот момент не
      // знаем, а рисовать поиск «на всякий случай» — ровно та ложь,
      // из-за которой признак и стал обязательным.
      .catch(
        () =>
          alive &&
          setMusic({ themes: [], selected: null, libraryEnabled: false })
      );
    return () => {
      alive = false;
    };
  }, [sessionId]);

  /** @returns ошибку, показанную на экране, или `null` — сохранено (K5). */
  const apply = async (
    fn: () => Promise<GreetingMusicView>
  ): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      setMusic(await fn());
      setMusicLoaded(true);
      return null;
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  const choose = (themeId: string | null) =>
    apply(() => selectGreetingMusic(sessionId, themeId));

  // Раньше секции не было вовсе, пока каталог пуст. Со своей музыкой
  // это перестало быть верным: загрузить трек можно и без каталога —
  // ждём только первой загрузки состояния.
  const summary = musicSummary(musicLoaded ? music : null, w);
  useEffect(() => {
    onSummary?.(summary);
  }, [onSummary, summary]);

  // Голос (K5): тема — тот же `choose(id)`, «без музыки» — тот же
  // `choose(null)`, что «Убрать»; тема — только из списка на экране (он
  // уже отфильтрован поводом). Строка поиска библиотеки — то же поле, без
  // запуска поиска. Хук — до раннего выхода.
  const voiceTexts = useSessionVoiceTexts();
  useVoiceFieldApplier({
    targets: music
      ? [
          SESSION_VOICE_TARGETS.musicTheme,
          SESSION_VOICE_TARGETS.musicEnabled,
          SESSION_VOICE_TARGETS.musicQuery,
        ]
      : [],
    describe: (f) =>
      (f.target === SESSION_VOICE_TARGETS.musicTheme
        ? music?.themes.find((t) => t.id === f.value)?.title
        : undefined) ?? describeSessionValue(f.value, dict.voiceFields),
    apply: (fields) => {
      const plan = planMusicVoice(music, busy, fields);
      if (plan.query !== undefined) setQuery(plan.query);
      const refusals = refusalLines(plan.refused, fields, voiceTexts);
      // Строка поиска ждёт кнопку «Искать»; тему и «без музыки» сохраняет
      // тот же `choose`, что у кнопок, — ждём его ответа.
      const typed =
        plan.query !== undefined ? [needsSave(w.musicLibrarySearch)] : [];
      if (plan.choose === undefined) return { refusals, effects: typed };
      return choose(plan.choose).then((err) => ({
        refusals,
        effects: [saveEffect(err), ...typed],
      }));
    },
  });

  if (!music) return null;

  // §3.5: у деликатного и траурного регистров своя музыка разрешена «с
  // предупреждением». Каталог сервер уже отфильтровал по поводу, а
  // загрузку, ссылку и библиотеку — нет: за уместность трека отвечает
  // человек, и сказать ему об этом нужно до выбора, а не после ролика.
  // Выдача библиотеки на экране — тоже «добавляю своё»: выбор из неё
  // делается в один клик, и предупреждение после клика опоздало бы.
  const ownMusicWarning = showOwnMusicWarning(rules, {
    adding: adding || (music.library?.length ?? 0) > 0,
    selected: music.selected,
  });

  return (
    <Card className="p-5" data-qa="greeting-music-card">
      <CardHeader
        icon={<Music size={18} />}
        title={w.musicHeading}
        hint={w.musicHint}
        action={
          <>
            <HelpButton cardHook="greeting-music-card" />
            {music.selected && (
              // Галочка «музыка» (K5): «выключить» — эта же кнопка.
              <Button
                data-qa="greeting-music-enabled"
                size="sm"
                variant="ghost"
                loading={busy}
                onClick={() => void choose(null)}
              >
                {w.musicClear}
              </Button>
            )}
          </>
        }
      />

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <p className="text-xs text-silver-400">
        {music.selected
          ? w.musicPicked.replace('{title}', music.selected.title)
          : w.musicEmpty}
      </p>
      {/* Упоминание автора не спрятано в мелкий шрифт: оно поедет в
          сам ролик, и человек должен это знать заранее. */}
      {music.selected?.attribution && (
        <p className="mt-1 text-xs text-silver-400">
          {w.musicCreditNote.replace('{credit}', music.selected.attribution)}
        </p>
      )}

      {ownMusicWarning && (
        <Alert tone="info" className="mt-3">
          {w.ownMusicWarning}
        </Alert>
      )}

      {music.themes.length > 0 && (
        <ul
          className="mt-3 flex flex-wrap gap-2"
          data-qa="greeting-music-theme"
        >
          {music.themes.map((theme) => (
            <li key={theme.id}>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                active={
                  music.selected?.source !== 'upload' &&
                  music.selected?.id === theme.id
                }
                onClick={() => void choose(theme.id)}
              >
                {theme.title}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Библиотека со свободной лицензией. Показывается только когда
          хоть один источник настроен: без ключей искать негде.
          Условие прямое, а не `!== false`: признак приходит с первым
          же GET, и «поля нет» больше не значит «наверное, есть». */}
      {music.libraryEnabled && (
        <div className="mt-3 border-t border-silver-200/60 pt-3 dark:border-silver-800">
          <p className="text-xs text-silver-400">{w.musicLibraryHint}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              data-qa="greeting-music-query"
              value={query}
              onChange={(e) => setQuery(e.target.value.slice(0, 100))}
              placeholder={w.musicLibraryPlaceholder}
              disabled={busy}
            />
            <Button
              size="sm"
              loading={busy}
              disabled={!query.trim()}
              onClick={() =>
                void apply(() =>
                  searchGreetingMusicLibrary(sessionId, query.trim())
                )
              }
            >
              {w.musicLibrarySearch}
            </Button>
          </div>

          {music.library && music.library.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {music.library.map((t) => (
                <li
                  key={`${t.provider}:${t.providerTrackId}`}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-silver-200/70 p-2 dark:border-silver-800"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {t.title}
                      {t.artist ? ` — ${t.artist}` : ''}
                    </p>
                    {/* Лицензия видна ДО выбора: человек должен
                        понимать, что берёт и на каких условиях. */}
                    <p className="text-[11px] text-silver-400">
                      {t.licenseType} · {Math.round(t.durationSec)}
                      {w.musicSecondsSuffix}
                      {t.attribution ? ` · ${w.musicAttributionRequired}` : ''}
                    </p>
                  </div>
                  {t.previewUrl && <LibraryPreviewAudio src={t.previewUrl} />}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void apply(() =>
                        selectGreetingMusicFromLibrary(
                          sessionId,
                          query.trim(),
                          t.provider,
                          t.providerTrackId
                        )
                      )
                    }
                  >
                    {w.musicLibraryPick}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-3 border-t border-silver-200/60 pt-3 dark:border-silver-800">
        {adding ? (
          <MusicUploader
            sessionId={sessionId}
            onDone={(next) => {
              setAdding(false);
              setMusic(next);
            }}
            onCancel={() => setAdding(false)}
            onError={setError}
          />
        ) : (
          <Button
            size="sm"
            variant="outline"
            icon={<Upload size={14} />}
            disabled={busy}
            onClick={() => setAdding(true)}
          >
            {w.musicUploadButton}
          </Button>
        )}
      </div>
    </Card>
  );
}

/**
 * Загрузка своей музыки.
 *
 * Подтверждение прав — не формальность: готовый ролик человек
 * отправляет другому человеку, и чужая фонограмма в нём это
 * распространение, а не личное прослушивание. Тот же гейт и та же
 * форма, что у согласия на клонирование голоса.
 */
function MusicUploader({
  sessionId,
  onDone,
  onCancel,
  onError,
}: {
  sessionId: string;
  onDone: (music: GreetingMusicView) => void;
  onCancel: () => void;
  onError: (msg: string | null) => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [rights, setRights] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!GREETING_MUSIC_ACCEPT.split(',').includes(f.type)) {
      onError(w.musicFormatOnly);
      return;
    }
    if (f.size > MAX_GREETING_MUSIC_BYTES) {
      onError(w.fileTooLarge);
      return;
    }
    onError(null);
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, '').slice(0, 80));
  };

  // Два способа дать трек — файл или ссылка. Оба ведут в одно и то же
  // место и оба требуют подтверждения прав: разница только в том, у
  // кого лежит файл.
  const ready = (file || url.trim()) && rights;

  const submit = async () => {
    if (!ready) return;
    setUploading(true);
    setProgress(0);
    onError(null);
    try {
      onDone(
        file
          ? await uploadGreetingMusic(
              sessionId,
              file,
              title.trim(),
              rights,
              setProgress
            )
          : await linkGreetingMusic(sessionId, url.trim(), title.trim(), rights)
      );
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">
      <input
        ref={fileRef}
        type="file"
        accept={GREETING_MUSIC_ACCEPT}
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0])}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={uploading || !!url.trim()}
          onClick={() => fileRef.current?.click()}
        >
          {file ? file.name : w.musicPickFile}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={uploading}
          onClick={onCancel}
        >
          {w.cancelButton}
        </Button>
      </div>

      {!file && (
        <Field label={w.musicLinkLabel} hint={w.musicLinkHint}>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value.trim())}
            placeholder="https://…"
            disabled={uploading}
          />
        </Field>
      )}

      {(file || url.trim()) && (
        <>
          <Field label={w.musicTitleLabel}>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 80))}
              disabled={uploading}
            />
          </Field>
          <label className="flex cursor-pointer gap-2 text-xs leading-relaxed">
            <input
              type="checkbox"
              checked={rights}
              onChange={(e) => setRights(e.target.checked)}
              disabled={uploading}
              className="mt-0.5 h-4 w-4 shrink-0 accent-sky-400"
            />
            <span>{w.musicRightsLabel}</span>
          </label>
          <Button
            size="sm"
            loading={uploading}
            disabled={!ready || uploading}
            onClick={() => void submit()}
          >
            {uploading && file ? `${progress}%` : w.musicUploadSubmit}
          </Button>
        </>
      )}
    </div>
  );
}
