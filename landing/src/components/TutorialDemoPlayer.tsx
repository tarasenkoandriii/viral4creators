'use client';

import { useState, useSyncExternalStore } from 'react';
import type { DemoTheme, TutorialDemo } from '../lib/tutorial-demo-api';
import {
  DARK_SCHEME_QUERY, demoStageSize, demoStageStyle, measuredDemoSize, pickDemoVariant, schemeFromMatches,
  type DemoChoice, type DemoSize,
} from '../lib/demo-stage';

/**
 * Системная тема посетителя — живая: смена темы в ОС приходит событием
 * `change`. На сервере и в первом проходе гидрации — `null` (тему знает
 * только браузер), и сцена рисует верхние поля, как до вариантов; сразу
 * после гидрации React перерисует её под настоящую тему без ошибки
 * расхождения.
 */
function subscribeScheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(DARK_SCHEME_QUERY);
  media.addEventListener?.('change', onChange);
  return () => media.removeEventListener?.('change', onChange);
}
function schemeSnapshot(): DemoTheme | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return schemeFromMatches(window.matchMedia(DARK_SCHEME_QUERY).matches);
}
const serverScheme = (): DemoTheme | null => null;

/**
 * Сцена (`.demo-stage`) берёт пропорцию ролика ДО его загрузки — из
 * `width/height` ответа API (`lib/demo-stage.ts`): вертикальный ролик
 * TMA — узкая рамка по центру, горизонтальный 16:9 — на всю ширину
 * колонки, квадрат — квадрат. Размера в ответе нет — прежняя вертикаль
 * 720:1560, а после нажатия `<video>` сам сообщает настоящий размер
 * (`onLoadedMetadata`), и сцена подстраивается.
 *
 * До первого нажатия `<video>` нет вовсе (и загрузки ролика тоже): есть
 * постер — первый кадр (`<img loading="lazy">`) под кнопкой
 * воспроизведения; нет постера — нейтральная сцена с той же кнопкой.
 *
 * Темы: у ролика бывают одобренные варианты светлой и тёмной темы
 * интерфейса (`variants`). Сцена берёт вариант по `prefers-color-scheme`
 * посетителя (`pickDemoVariant`); сменил человек тему ОС до нажатия —
 * меняются постер и пропорция. После нажатия выбор замораживается:
 * идущее видео из-за смены темы не перезапускается.
 */
export function TutorialDemoPlayer({ items, openVideo, chooseTopic, play }: {
  items: TutorialDemo[]; openVideo: string; chooseTopic: string; play: string;
}) {
  const [selected, setSelected] = useState(items[0].subjectKey);
  // Не просто «нажато», а КАКОЙ вариант запущен: он и играет дальше,
  // какая бы тема ни пришла потом.
  const [started, setStarted] = useState<DemoChoice | null>(null);
  // Размеры, которые сообщил сам ролик, — по адресу: тема переключается,
  // а измеренное у одного ролика не должно достаться другому.
  const [measured, setMeasured] = useState<Record<string, DemoSize>>({});
  const scheme = useSyncExternalStore(subscribeScheme, schemeSnapshot, serverScheme);
  const item = items.find((entry) => entry.subjectKey === selected) ?? items[0];
  const shown = started ?? pickDemoVariant(item, scheme);
  const size = demoStageSize(measured[shown.videoUrl], shown);
  return (
    <div className="tutorial-demo-player">
      <div className="demo-topics" role="group" aria-label={chooseTopic}>
        {items.map((entry) => (
          <button type="button" key={entry.subjectKey} aria-pressed={item.subjectKey === entry.subjectKey}
            onClick={() => { setSelected(entry.subjectKey); setStarted(null); }}>{entry.title}</button>
        ))}
      </div>
      <h3>{item.title}</h3>
      <div className={shown.posterUrl ? 'demo-stage has-poster' : 'demo-stage'} style={demoStageStyle(size)}
        data-demo-size={`${size.width}x${size.height}`} data-demo-theme={shown.theme ?? undefined}>
        {started ? (
          <video key={shown.videoUrl} src={shown.videoUrl} poster={shown.posterUrl ?? undefined} controls autoPlay playsInline
            preload="none" aria-label={item.title}
            onLoadedMetadata={(event) => {
              const real = measuredDemoSize(event.currentTarget.videoWidth, event.currentTarget.videoHeight);
              if (!real) return;
              const url = shown.videoUrl;
              setMeasured((prev) => {
                const known = prev[url];
                return known && known.width === real.width && known.height === real.height ? prev : { ...prev, [url]: real };
              });
            }} />
        ) : (
          <>
            {shown.posterUrl ? (
              // next/image здесь не нужен: постер — уже готовый кадр нужного
              // размера в нашем Blob, а оптимизатор потребовал бы держать
              // список его хостов в конфиге.
              // eslint-disable-next-line @next/next/no-img-element
              <img key={shown.posterUrl} className="demo-poster" src={shown.posterUrl} alt="" loading="lazy" decoding="async" />
            ) : null}
            <button type="button" className="demo-play" aria-label={`${play}: ${item.title}`} onClick={() => setStarted(shown)}>
              <span className="demo-play-icon" aria-hidden="true" />
              <span className="demo-play-text">{play}</span>
            </button>
          </>
        )}
      </div>
      <p className="demo-link"><a href={shown.videoUrl} target="_blank" rel="noreferrer">{openVideo}</a></p>
    </div>
  );
}
