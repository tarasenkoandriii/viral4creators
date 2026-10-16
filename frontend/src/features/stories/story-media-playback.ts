import type { SyntheticEvent } from 'react';
/** Never play original speech and the muxed export simultaneously. */
export function exclusiveStoryPlayback(
  event: SyntheticEvent<HTMLMediaElement>
) {
  document
    .querySelectorAll<HTMLMediaElement>('audio,video')
    .forEach((media) => {
      if (media !== event.currentTarget) media.pause();
    });
}
