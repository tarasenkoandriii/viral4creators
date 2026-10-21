/** Explicit pixel coordinates for editorial titles in an already rendered video.
 * SRT force_style uses an implicit ASS canvas; its font/margin values are not
 * output pixels. A model supplies a proposed safe rectangle, never ASS or shell.
 * The caller reviews that rectangle against every scene before rendering.
 */
export interface PostprodTitleLayout {
  width: number;
  height: number;
  box: { x: number; y: number; width: number; height: number };
  fontSize: number;
}

export interface PostprodTitleCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

function finite(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function timestamp(seconds: number): string {
  const cs = Math.round(seconds * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** No libass overrides, new events or injected positions from model text. */
function literal(text: string): string {
  return text
    .replace(/\\/g, '＼')
    .replace(/[{}]/g, '')
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ');
}

export function buildPostprodTitlesAss(
  layout: PostprodTitleLayout,
  cues: readonly PostprodTitleCue[],
  durationSeconds: number,
): string {
  const { width, height, box, fontSize } = layout;
  if (
    ![width, height, box.x, box.y, box.width, box.height, fontSize].every(
      (n) => finite(n) && Number.isInteger(n),
    ) ||
    width < 16 ||
    width > 1920 ||
    height < 16 ||
    height > 1920 ||
    box.x < 0 ||
    box.y < 0 ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.x + box.width > width ||
    box.y + box.height > height ||
    fontSize < 12 ||
    fontSize > 72 ||
    !finite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > 600 ||
    cues.length === 0 ||
    cues.length > 100
  ) {
    throw new Error('Invalid title layout');
  }
  let previousEnd = 0;
  const events = cues.map((cue) => {
    if (
      !finite(cue.startSeconds) ||
      !finite(cue.endSeconds) ||
      cue.startSeconds < previousEnd ||
      Math.round(cue.endSeconds * 100) <= Math.round(cue.startSeconds * 100) ||
      cue.endSeconds > durationSeconds ||
      typeof cue.text !== 'string' ||
      !cue.text.trim() ||
      cue.text.length > 160
    ) {
      throw new Error('Invalid title cue');
    }
    previousEnd = cue.endSeconds;
    // Conservative box fit: one full-width glyph per fontSize, two outline
    // pixels on each side. Reject overflow rather than crop valuable content.
    const text = literal(cue.text).trim();
    if (
      !text ||
      [...text].length * fontSize + 4 > box.width ||
      fontSize * 1.5 + 4 > box.height
    ) {
      throw new Error('Title does not fit the proposed safe rectangle');
    }
    const x = box.x + Math.floor(box.width / 2);
    return `Dialogue: 0,${timestamp(cue.startSeconds)},${timestamp(cue.endSeconds)},Title,,0,0,0,,{\\an8\\pos(${x},${box.y + 2})}${text}`;
  });
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Title,DejaVu Sans,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
