import { createHash } from 'node:crypto';
import { estimateCost } from '../../common/ai-pricing';
import { STORY_VIDEO_BASE } from './story-video-base';
export const storyDigest = (input: string | Uint8Array) =>
  createHash('sha256').update(input).digest('hex');
/** Main narration is not synthesized here. Reserve includes intro TTS, one render and one QA. */
export function storyVideoReserve(preamble: string): number {
  const tts = estimateCost('resemble-tts', { characters: preamble.length });
  const assembly = estimateCost('ffmpeg-api', {});
  if (tts.unpriced || assembly.unpriced)
    throw new Error('Story assembly rate unavailable');
  return Math.ceil(
    tts.costMicroUsd * 4 + Math.max(500000, assembly.costMicroUsd * 50) + 20000,
  );
}
export function storyVideoConfigHash(audioHash: string, preamble: string) {
  return storyDigest(
    JSON.stringify({
      version: 1,
      base: STORY_VIDEO_BASE.baseSha256,
      audioHash,
      preamble,
    }),
  );
}
/** Only fixed placeholders and finite server-validated durations enter the command. Never user text/URLs. */
export function planStoryVideo(mainSeconds: number, introSeconds: number) {
  if (
    !Number.isFinite(mainSeconds) ||
    mainSeconds < 40 ||
    mainSeconds > 90 ||
    !Number.isFinite(introSeconds) ||
    introSeconds < 1 ||
    introSeconds > 20
  )
    throw new Error('Invalid story durations');
  const main = mainSeconds.toFixed(6),
    intro = introSeconds.toFixed(6);
  const factor = (mainSeconds / STORY_VIDEO_BASE.durationSeconds).toFixed(8);
  return {
    durationSeconds: mainSeconds + introSeconds,
    outputs: ['story.mp4'],
    commands: [
      `ffmpeg -i {{base}} -i {{main}} -loop 1 -framerate 25 -i {{cover}} -i {{intro}} -filter_complex "[2:v]scale=1280:720,setsar=1,fps=25,trim=duration=${intro},setpts=PTS-STARTPTS[iv];[3:a]aresample=48000,apad,atrim=duration=${intro},asetpts=PTS-STARTPTS[ia];[0:v]setpts=${factor}*(PTS-STARTPTS),fps=25,trim=duration=${main},scale=1280:720,setsar=1[v];[1:a]aresample=48000,apad,atrim=duration=${main},asetpts=PTS-STARTPTS[a];[iv][ia][v][a]concat=n=2:v=1:a=1[outv][outa]" -map "[outv]" -map "[outa]" -c:v libx264 -preset veryfast -crf 25 -pix_fmt yuv420p -c:a aac -b:a 128k -ar 48000 -movflags +faststart -t ${(mainSeconds + introSeconds).toFixed(6)} {{story.mp4}}`,
    ],
  };
}
