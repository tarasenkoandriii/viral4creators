"use client";
import { useState } from "react";
export type Film = {
  src: string;
  poster: string;
  posterAvif?: string;
  title: string;
  description: string;
};
/** A poster-only first paint; mounting one video stops the previous selection. */
export function MediaPlayer({ items, play }: { items: Film[]; play: string }) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <div className="media-grid">
      {items.map((item) => (
        <figure className="media-card" key={item.src}>
          <div className="media-frame">
            {active === item.src ? (
              /* Process clips are silent with their steps described below; published originals stay unchanged. */
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                key={item.src}
                src={item.src}
                poster={item.poster}
                controls
                tabIndex={0}
                ref={(node) => { node?.focus(); }}
                playsInline
                autoPlay
                preload="none"
                aria-label={item.title}
              />
            ) : (
              <button
                className="media-launch"
                type="button"
                onClick={() => setActive(item.src)}
                aria-label={`${play}: ${item.title}`}
              >
                <picture>
                {item.posterAvif && <source srcSet={item.posterAvif} type="image/avif" />}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.poster}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  width="960"
                  height="540"
                />
                </picture>
                <span className="media-play">{play}</span>
              </button>
            )}
          </div>
          <figcaption>
            <h3>{item.title}</h3>
            <p>{item.description}</p>
            <a href={item.src} target="_blank" rel="noreferrer">
              {play} ↗
            </a>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
