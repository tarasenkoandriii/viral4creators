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
 * that must not be accepted, incl. an output over `STORY_MAX_VIDEO`. The
 * movie header alone can hide a truncated video or an overlong audio track;
 * the single nonempty pair must align within 150 ms (including AAC rounding). Any other
 * error means "not confirmed yet" (network, provider).
 */
export async function downloadStoryVideo(
  url: string | undefined,
  expectedSeconds: number,
) {
  if (!url || !Number.isFinite(expectedSeconds) || expectedSeconds <= 0)
    throw new StoryVideoRejectedError();
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
    videos = probe?.tracks.filter((t) => t.kind === 'video') ?? [],
    audios = probe?.tracks.filter((t) => t.kind === 'audio') ?? [],
    video = videos[0],
    audio = audios[0];
  if (
    !probe ||
    bytes.length < 1024 ||
    videos.length !== 1 ||
    audios.length !== 1 ||
    !Number.isFinite(probe.durationSeconds) ||
    !Number.isFinite(video.durationSeconds) ||
    !Number.isFinite(audio.durationSeconds) ||
    !Number.isSafeInteger(video.samples) ||
    video.samples <= 0 ||
    !Number.isSafeInteger(audio.samples) ||
    audio.samples <= 0 ||
    video.width !== 1280 ||
    video.height !== 720 ||
    Math.abs(probe.durationSeconds - expectedSeconds) > 0.15 ||
    Math.abs(video.durationSeconds - expectedSeconds) > 0.15 ||
    Math.abs(audio.durationSeconds - expectedSeconds) > 0.15 ||
    Math.abs(video.durationSeconds - audio.durationSeconds) > 0.15
  )
    throw new StoryVideoRejectedError();
  return {
    bytes,
    videoHash: digest(bytes),
    durationSeconds: probe.durationSeconds,
  };
}
