'use client';

import { useState } from 'react';
import type { TutorialDemo } from '../lib/tutorial-demo-api';

/**
 * Ролики обучалки вертикальные (720×1560, `tutorial-video-assembly.ts`),
 * поэтому сцена — вертикальная рамка по центру (`.demo-stage`), а не
 * широкий чёрный прямоугольник. Кадра-постера API не отдаёт, поэтому до
 * первого нажатия вместо пустого `<video>` с полосой управления —
 * нейтральная сцена с кнопкой воспроизведения; сам `<video>` (и загрузка
 * ролика) появляется только после нажатия.
 */
export function TutorialDemoPlayer({ items, openVideo, chooseTopic, play }: {
  items: TutorialDemo[]; openVideo: string; chooseTopic: string; play: string;
}) {
  const [selected, setSelected] = useState(items[0].subjectKey);
  const [started, setStarted] = useState(false);
  const item = items.find((entry) => entry.subjectKey === selected) ?? items[0];
  return (
    <div className="tutorial-demo-player">
      <div className="demo-topics" role="group" aria-label={chooseTopic}>
        {items.map((entry) => (
          <button type="button" key={entry.subjectKey} aria-pressed={item.subjectKey === entry.subjectKey}
            onClick={() => { setSelected(entry.subjectKey); setStarted(false); }}>{entry.title}</button>
        ))}
      </div>
      <h3>{item.title}</h3>
      <div className="demo-stage">
        {started ? (
          <video key={item.videoUrl} src={item.videoUrl} controls autoPlay playsInline aria-label={item.title} />
        ) : (
          <button type="button" className="demo-play" aria-label={`${play}: ${item.title}`} onClick={() => setStarted(true)}>
            <span className="demo-play-icon" aria-hidden="true" />
            <span className="demo-play-text">{play}</span>
          </button>
        )}
      </div>
      <p className="demo-link"><a href={item.videoUrl} target="_blank" rel="noreferrer">{openVideo}</a></p>
    </div>
  );
}
