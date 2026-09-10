import { useEffect, useState, ChangeEvent, FormEvent } from 'react';
import { Film, Link2, Lock, UploadCloud } from 'lucide-react';
import { Button, Card, CardHeader, Field, Input, LockedNote, Tabs } from './ui';
import { YoutubeSearch, type YoutubeSearchDefaults } from './YoutubeSearch';
import { LibraryPicker } from './LibraryPicker';
import { useFeature } from '../lib/plan-context';
import { useI18n } from '../lib/i18n-context';

interface VideoUploadProps {
  onUploadStart: (file: File) => void;
  onSubmitYoutubeUrl: (youtubeUrl: string) => void;
  onUploadError: (error: string) => void;
  isUploading: boolean;
  isInitializing: boolean;
  /**
   * Pre-fill for the YouTube search tab (spec §9.1 — from the ProductItem
   * the session was started from). When present the search tab opens
   * first; the anonymous quick path starts on the file tab as before.
   */
  searchDefaults?: YoutubeSearchDefaults | null;
  /**
   * Spec §21: библиотека. Вкладок становится четыре, но ИСТОЧНИКОВ
   * по-прежнему три — поиск и ссылка ведут в один и тот же YouTube,
   * поэтому в ТЗ это «третий путь подобрать сценарий».
   */
  sessionId?: string | null;
  onPickLibraryEntry?: (entryId: string) => void;
  hasProduct?: boolean;
}

const YOUTUBE_URL_PATTERN =
  /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/i;

type SourceMode = 'library' | 'search' | 'youtube' | 'upload';

/**
 * VideoUpload Component
 *
 * Four equal ways to provide the reference (spec §9.2 + §21): a ready
 * analysis from the library (no Gemini call at all — straight to the
 * analysis step), search YouTube (→ the same registerYoutubeVideo flow as
 * a pasted link), paste a public YouTube link (Gemini fetches it), or
 * upload a file (Vercel Blob → Gemini Files API). The library tab opens
 * first for a project-bound session: it is the cheapest and fastest path,
 * and it is ranked against this very product.
 */
export function VideoUpload({
  onUploadStart,
  onSubmitYoutubeUrl,
  onUploadError,
  isUploading,
  isInitializing,
  searchDefaults,
  sessionId,
  onPickLibraryEntry,
  hasProduct = false,
}: VideoUploadProps) {
  const { dict } = useI18n();
  // ТЗ §23: библиотека — возможность режима. Вкладка остаётся на месте и
  // в Lite/Standard, но открывается замком: спрятать её значило бы, что
  // пользователь никогда не узнает о самом быстром из трёх путей.
  const library = useFeature('library');
  const [mode, setMode] = useState<SourceMode>(
    onPickLibraryEntry && searchDefaults
      ? 'library'
      : searchDefaults
        ? 'search'
        : 'upload'
  );
  /** Вкладку выбрал сам пользователь — авто-переключение больше не лезет. */
  const [picked, setPicked] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');

  // Матрица приходит асинхронно, а вкладка по умолчанию выбирается сразу:
  // как только выяснилось, что библиотека закрыта, уводим с неё — иначе
  // пользователь Lite открывает мастер на замке вместо работы. Но если на
  // «Библиотеку» нажали руками, значит хотят увидеть, что там: замок с
  // объяснением, а не молчаливый отскок обратно.
  useEffect(() => {
    if (!picked && !library.loading && !library.allowed && mode === 'library') {
      setMode(searchDefaults ? 'search' : 'upload');
    }
  }, [picked, library.loading, library.allowed, mode, searchDefaults]);

  const disabled = isUploading || isInitializing;

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];
    if (!allowedTypes.includes(file.type)) {
      onUploadError(dict.videoUpload.unsupportedFormat);
      return;
    }

    // Validate file size (100MB max)
    const maxSize = 100 * 1024 * 1024;
    if (file.size > maxSize) {
      onUploadError(dict.videoUpload.tooLarge);
      return;
    }

    setSelectedFile(file);
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    onUploadStart(selectedFile);
  };

  const handleYoutubeSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = youtubeUrl.trim();
    if (!trimmed) return;

    if (!YOUTUBE_URL_PATTERN.test(trimmed)) {
      onUploadError(dict.videoUpload.linkUnsupported);
      return;
    }

    onSubmitYoutubeUrl(trimmed);
  };

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Film size={18} className="text-accent" />}
        title={dict.videoUpload.title}
        hint={dict.videoUpload.hint}
      />

      <Tabs
        value={mode}
        onChange={(v) => {
          setPicked(true);
          setMode(v);
        }}
        disabled={disabled}
        compact
        tabs={[
          ...(onPickLibraryEntry
            ? [
                {
                  value: 'library' as const,
                  label: library.allowed ? (
                    dict.videoUpload.tabLibrary
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <Lock size={10} /> {dict.videoUpload.tabLibrary}
                    </span>
                  ),
                },
              ]
            : []),
          {
            value: 'search',
            // С четвёртой вкладкой полное «Поиск YouTube» не помещается на
            // 390px — оставляем короткое, смысл держит подпись карточки.
            label: onPickLibraryEntry
              ? dict.videoUpload.tabYoutubeShort
              : dict.videoUpload.tabYoutubeSearch,
          },
          { value: 'youtube', label: dict.videoUpload.tabLink },
          { value: 'upload', label: dict.videoUpload.tabFile },
        ]}
      />

      {mode === 'library' &&
        onPickLibraryEntry &&
        (library.allowed ? (
          <LibraryPicker
            sessionId={sessionId ?? null}
            onPick={onPickLibraryEntry}
            disabled={disabled}
            hasProduct={hasProduct}
          />
        ) : (
          <LockedNote
            title={dict.videoUpload.libraryLockedTitle}
            lock={library.lock}
            compact
          >
            {dict.videoUpload.libraryLockedBody}
          </LockedNote>
        ))}

      {mode === 'search' && (
        <YoutubeSearch
          defaults={searchDefaults ?? undefined}
          onSelect={onSubmitYoutubeUrl}
          disabled={disabled}
        />
      )}

      {mode === 'upload' && (
        <div className="space-y-4">
          <label
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center transition-colors ${
              selectedFile
                ? 'border-accent/60 bg-accent/5'
                : 'border-silver-300 dark:border-silver-700 hover:border-accent'
            } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
          >
            <UploadCloud size={28} className="text-silver-400" />
            {selectedFile ? (
              <>
                <span className="text-sm font-medium truncate max-w-full">
                  {selectedFile.name}
                </span>
                <span className="text-xs text-silver-400 tabular">
                  {(selectedFile.size / (1024 * 1024)).toFixed(2)}{' '}
                  {dict.videoUpload.megabyte}
                </span>
              </>
            ) : (
              <>
                <span className="text-sm">{dict.videoUpload.chooseFile}</span>
                <span className="text-xs text-silver-400">
                  {dict.videoUpload.fileHint}
                </span>
              </>
            )}
            <input
              id="video-upload"
              type="file"
              accept="video/mp4,video/quicktime,video/x-msvideo"
              onChange={handleFileChange}
              disabled={disabled}
              className="hidden"
            />
          </label>

          {isUploading && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-silver-200/60 dark:bg-silver-800/60">
              <div className="h-full w-1/2 animate-pulse rounded-full bg-accent" />
            </div>
          )}

          <Button
            block
            size="lg"
            onClick={handleUpload}
            disabled={!selectedFile || disabled}
            loading={disabled}
          >
            {isInitializing
              ? dict.videoUpload.preparing
              : isUploading
                ? dict.videoUpload.uploading
                : dict.videoUpload.uploadVideo}
          </Button>
        </div>
      )}

      {mode === 'youtube' && (
        <form onSubmit={handleYoutubeSubmit} className="space-y-4">
          <Field
            label={dict.videoUpload.linkLabel}
            htmlFor="youtube-url"
            hint={dict.videoUpload.linkHint}
          >
            <div className="relative">
              <Link2
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-silver-400"
              />
              <Input
                id="youtube-url"
                type="url"
                placeholder="https://www.youtube.com/watch?v=…"
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
                disabled={disabled}
                className="pl-8"
              />
            </div>
          </Field>

          <Button
            block
            size="lg"
            type="submit"
            disabled={!youtubeUrl.trim() || disabled}
            loading={disabled}
          >
            {isInitializing
              ? dict.videoUpload.preparing
              : isUploading
                ? dict.videoUpload.registering
                : dict.videoUpload.useThisVideo}
          </Button>
        </form>
      )}
    </Card>
  );
}
