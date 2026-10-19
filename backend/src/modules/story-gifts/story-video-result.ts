import {
  fetchPubliclyRoutable,
  readBodyWithLimit,
} from '../../common/external-url-guard';
import { probeMp4 } from '../tutorial-runner/mp4-probe';
import { storyDigest as digest } from './story-video-plan';

export const STORY_MAX_VIDEO = 3 * 1024 * 1024;

/**
 * Downloads and validates one completed FFmpeg output. Shared by the
 * owner's status poll, the cron reconciliation and the operator binding of a
 * confirmed job, so all three accept exactly the same container.
 * Throws `Error('Invalid container')` for a result that must not be accepted;
 * any other error means "not confirmed yet" (network, provider).
 */
export async function downloadStoryVideo(
  url: string | undefined,
  expectedSeconds: number,
) {
  if (!url) throw new Error('Invalid container');
  const res = await fetchPubliclyRoutable(url, {
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('Download failed');
  const bytes = await readBodyWithLimit(res, STORY_MAX_VIDEO);
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
    throw new Error('Invalid container');
  return {
    bytes,
    videoHash: digest(bytes),
    durationSeconds: probe.durationSeconds,
  };
}
