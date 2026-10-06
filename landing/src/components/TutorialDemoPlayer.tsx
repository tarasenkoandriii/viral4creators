'use client';

import { useState } from 'react';
import type { TutorialDemo } from '../lib/tutorial-demo-api';
import { demoStageSize, demoStageStyle, measuredDemoSize, type DemoSize } from '../lib/demo-stage';

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
 */
export function TutorialDemoPlayer({ items, openVideo, chooseTopic, play }: {
  items: TutorialDemo[]; openVideo: string; chooseTopic: string; play: string;
}) {
  const [selected, setSelected] = useState(items[0].subjectKey);
  const [started, setStarted] = useState(false);
  // Размеры, которые сообщил сам ролик, — по адресу: тема переключается,
  // а измеренное у одного ролика не должно достаться другому.
  const [measured, setMeasured] = useState<Record<string, DemoSize>>({});
  const item = items.find((entry) => entry.subjectKey === selected) ?? items[0];
  const size = demoStageSize(measured[item.videoUrl], item);
  return (
    <div className="tutorial-demo-player">
      <div className="demo-topics" role="group" aria-label={chooseTopic}>
        {items.map((entry) => (
          <button type="button" key={entry.subjectKey} aria-pressed={item.subjectKey === entry.subjectKey}
            onClick={() => { setSelected(entry.subjectKey); setStarted(false); }}>{entry.title}</button>
        ))}
      </div>
      <h3>{item.title}</h3>
      <div className={item.posterUrl ? 'demo-stage has-poster' : 'demo-stage'} style={demoStageStyle(size)}
        data-demo-size={`${size.width}x${size.height}`}>
        {started ? (
          <video key={item.videoUrl} src={item.videoUrl} poster={item.posterUrl ?? undefined} controls autoPlay playsInline
            preload="none" aria-label={item.title}
            onLoadedMetadata={(event) => {
              const real = measuredDemoSize(event.currentTarget.videoWidth, event.currentTarget.videoHeight);
              if (!real) return;
              const url = item.videoUrl;
              setMeasured((prev) => {
                const known = prev[url];
                return known && known.width === real.width && known.height === real.height ? prev : { ...prev, [url]: real };
              });
            }} />
        ) : (
          <>
            {item.posterUrl ? (
              // next/image здесь не нужен: постер — уже готовый кадр нужного
              // размера в нашем Blob, а оптимизатор потребовал бы держать
              // список его хостов в конфиге.
              // eslint-disable-next-line @next/next/no-img-element
              <img key={item.posterUrl} className="demo-poster" src={item.posterUrl} alt="" loading="lazy" decoding="async" />
            ) : null}
            <button type="button" className="demo-play" aria-label={`${play}: ${item.title}`} onClick={() => setStarted(true)}>
              <span className="demo-play-icon" aria-hidden="true" />
              <span className="demo-play-text">{play}</span>
            </button>
          </>
        )}
      </div>
      <p className="demo-link"><a href={item.videoUrl} target="_blank" rel="noreferrer">{openVideo}</a></p>
    </div>
  );
}
