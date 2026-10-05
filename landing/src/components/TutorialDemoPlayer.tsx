'use client';

import { useState } from 'react';
import type { TutorialDemo } from '../lib/tutorial-demo-api';

export function TutorialDemoPlayer({ items, openVideo, chooseTopic }: { items: TutorialDemo[]; openVideo: string; chooseTopic: string }) {
  const [selected, setSelected] = useState(items[0].subjectKey);
  const item = items.find((entry) => entry.subjectKey === selected) ?? items[0];
  return (
    <div className="tutorial-demo-player">
      <div className="demo-topics" role="group" aria-label={chooseTopic}>
        {items.map((entry) => (
          <button type="button" key={entry.subjectKey} aria-pressed={item.subjectKey === entry.subjectKey}
            onClick={() => setSelected(entry.subjectKey)}>{entry.title}</button>
        ))}
      </div>
      <h3>{item.title}</h3>
      <video key={item.videoUrl} src={item.videoUrl} controls playsInline preload="none" aria-label={item.title} />
      <p className="demo-link"><a href={item.videoUrl} target="_blank" rel="noreferrer">{openVideo}</a></p>
    </div>
  );
}
