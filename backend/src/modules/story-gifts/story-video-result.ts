import {
  BodyTooLargeError,
  fetchPubliclyRoutable,
  readBodyWithLimit,
} from '../../common/external-url-guard';
import { probeMp4 } from '../tutorial-runner/mp4-probe';
import { storyDigest as digest } from './story-video-plan';

export const STORY_MAX_VIDEO = 3 * 1024 * 1024;

/**
 * `Error('Invalid container')` — the completed result can never be accepted
 * (re-downloading cannot change it). `tooLarge` (ST2-S-05): the output is
 * bigger than `STORY_MAX_VIDEO`; callers close the render FAILED with that
 * reason instead of "not confirmed yet" and never download it again.
 */
export class StoryVideoRejectedError extends Error {
  constructor(readonly tooLarge = false) {
    super('Invalid container');
  }
}
const isBodyTooLarge = (e: unknown) =>
  typeof BodyTooLargeError === 'function' && e instanceof BodyTooLargeError;

/**
 * Downloads and validates one completed FFmpeg output. Shared by the
 * owner's status poll, the cron reconciliation and the operator binding of a
 * confirmed job, so all three accept exactly the same container.
 * Throws `StoryVideoRejectedError` (message 'Invalid container') for a result
 * that must not be accepted, incl. an output over `STORY_MAX_VIDEO`; any other
 * error means "not confirmed yet" (network, provider).
 */
export async function downloadStoryVideo(
  url: string | undefined,
  expectedSeconds: number,
) {
  if (!url) throw new StoryVideoRejectedError();
  const res = await fetchPubliclyRoutable(url, {
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('Download failed');
  const declared = Number(res.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > STORY_MAX_VIDEO)
    throw new StoryVideoRejectedError(true);
  let bytes: Buffer;
  try {
    bytes = await readBodyWithLimit(res, STORY_MAX_VIDEO);
  } catch (e) {
    // ST2-S-05: deterministic — the same job output stays too large forever.
    if (isBodyTooLarge(e)) throw new StoryVideoRejectedError(true);
    throw e;
  }
  const probe = probeMp4(bytes),
    video = probe?.tracks.find((t) => t.kind === 'video'),
    audio = probe?.tracks.find((t) => t.kind === 'audio');
  if (
    !probe ||
    bytes.length < 1024 ||
    !video ||
    !audio ||
    video.width !== 1280 ||
    video.height !== 720 ||
    Math.abs(probe.durationSeconds - expectedSeconds) > 0.15 ||
    audio.durationSeconds + 0.15 < expectedSeconds
  )
    throw new StoryVideoRejectedError();
  return {
    bytes,
    videoHash: digest(bytes),
    durationSeconds: probe.durationSeconds,
  };
}
