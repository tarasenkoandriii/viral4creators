/** Offline manifest compiler. No upload, rendering, credentials or provider calls.
 * Usage: npx ts-node scripts/plan-postprod-titles.ts SOURCE.mp4 REVIEW.json OUTPUT_DIR
 * REVIEW: {sourceSha256,width,height,durationSeconds,layout,cues}.
 * Output dir must be new. The source hash and ffprobe geometry must match.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildPostprodTitlesAss,
  PostprodTitleLayout,
  PostprodTitleCue,
} from '../src/common/postprod-titles';
import { planPostProduction } from '../src/common/postprod';

const [sourceArg, reviewArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !reviewArg || !outputArg || process.argv.length !== 5) {
  throw new Error('Expected SOURCE.mp4 REVIEW.json NEW_OUTPUT_DIR');
}
const source = resolve(sourceArg);
const review = JSON.parse(readFileSync(reviewArg, 'utf8')) as {
  sourceSha256: string;
  width: number;
  height: number;
  durationSeconds: number;
  layout: PostprodTitleLayout;
  cues: PostprodTitleCue[];
};
const sourceSha256 = createHash('sha256')
  .update(readFileSync(source))
  .digest('hex');
if (sourceSha256 !== review.sourceSha256)
  throw new Error('Stale source: SHA-256 changed');
const probe = JSON.parse(
  execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 },
  ),
) as {
  streams: { codec_type: string; width?: number; height?: number }[];
  format: { duration: string };
};
const videos = probe.streams.filter((s) => s.codec_type === 'video');
if (
  videos.length !== 1 ||
  videos[0].width !== review.width ||
  videos[0].height !== review.height ||
  review.layout.width !== review.width ||
  review.layout.height !== review.height ||
  !Number.isFinite(review.durationSeconds) ||
  !Number.isFinite(Number(probe.format.duration)) ||
  Math.abs(Number(probe.format.duration) - review.durationSeconds) > 0.05
) {
  throw new Error('Stale review: measured geometry/duration differs');
}
const ass = buildPostprodTitlesAss(
  review.layout,
  review.cues,
  review.durationSeconds,
);
const recipe = {
  cardsInputKey: 'titles',
  inputKey: 'source',
  outputName: 'reviewed-titles.mp4',
};
const plan = planPostProduction(recipe);
const manifest = {
  schemaVersion: 1,
  advisoryOnly: true,
  sourceSha256,
  measured: {
    width: review.width,
    height: review.height,
    durationSeconds: review.durationSeconds,
    audioStreams: probe.streams.filter((s) => s.codec_type === 'audio').length,
  },
  layout: review.layout,
  cues: review.cues,
  titlesSha256: createHash('sha256').update(ass).digest('hex'),
  recipe,
  plan,
  recipeSha256: createHash('sha256')
    .update(
      JSON.stringify({ recipe, layout: review.layout, cues: review.cues }),
    )
    .digest('hex'),
};
// Must not overwrite an earlier reviewed manifest or render.
mkdirSync(outputArg, { recursive: false, mode: 0o700 });
writeFileSync(resolve(outputArg, 'titles.ass'), ass, {
  flag: 'wx',
  mode: 0o600,
});
writeFileSync(
  resolve(outputArg, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 },
);
console.log('Offline manifest compiled. No render submitted.');
