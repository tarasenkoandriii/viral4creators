import React from 'react';
import { Download } from 'lucide-react';
import { Button } from './ui';
import { useI18n } from '../lib/i18n-context';

/** Вариант одного и того же ролика — «до» и «после» обработки (§15.5). */
export interface VideoVariant {
  key: string;
  label: string;
  url: string;
}

interface VideoPlayerProps {
  videoUrl: string;
  title: string;
  downloadUrl?: string;
  className?: string;
  /**
   * Варианты одного ролика. Больше одного — над плеером появляется
   * переключатель: сравнить «до и после» обработки, не уходя с экрана и
   * не открывая исходник в новой вкладке, где рядом с ним ничего нет.
   * Скачивается всегда ТЕКУЩИЙ вариант — иначе кнопка врёт.
   */
  variants?: VideoVariant[];
}

/**
 * VideoPlayer component with playback controls and download button
 */
export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  videoUrl,
  title,
  downloadUrl,
  className = '',
  variants,
}) => {
  const { dict } = useI18n();
  const choices = variants && variants.length > 1 ? variants : null;
  const [picked, setPicked] = React.useState(choices?.[0]?.key ?? '');
  const current = choices?.find((v) => v.key === picked) ?? null;
  const src = current?.url ?? videoUrl;
  // Скачивание идёт за переключателем: кнопка, отдающая не то, что
  // сейчас играет, — это ошибка, которую замечают уже после отправки.
  const download = current ? current.url : downloadUrl;

  const handleDownload = () => {
    if (download) {
      const link = document.createElement('a');
      link.href = download;
      link.download = `${title.toLowerCase().replace(/\s+/g, '-')}.mp4`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {choices && (
        <div className="flex gap-1.5">
          {choices.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setPicked(v.key)}
              className={`min-h-[44px] rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                v.key === picked
                  ? 'bg-accent text-accent-on'
                  : 'bg-silver-100 text-silver-500 hover:text-accent dark:bg-silver-900'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}
      <div className="overflow-hidden rounded-xl bg-black ring-1 ring-silver-200/60 dark:ring-silver-800">
        <video
          key={src}
          src={src}
          controls
          className="w-full h-auto"
          playsInline
          preload="metadata"
        >
          Your browser does not support the video tag.
        </video>
      </div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {download && (
          <Button
            size="sm"
            variant="outline"
            icon={<Download size={14} />}
            onClick={handleDownload}
          >
            {dict.videoPlayer.download}
          </Button>
        )}
      </div>
    </div>
  );
};
