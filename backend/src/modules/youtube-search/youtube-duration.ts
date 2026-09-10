/**
 * ISO 8601 duration as YouTube's videos.list `contentDetails.duration`
 * returns it (`PT4M13S`, `PT1H2M`, `P1DT2H`, `PT0S`) → seconds, and a
 * compact label for the results table (spec §6.4: "парсить в
 * человекочитаемый и сортируемый вид"). Sorting uses the number, the UI
 * shows the label.
 */

const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** Returns null for anything that is not an ISO 8601 duration. */
export function parseIsoDuration(
  value: string | undefined | null,
): number | null {
  if (!value) return null;
  const m = ISO_DURATION.exec(value.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  // "P" / "PT" match the grammar but carry no components — not a duration.
  if (
    d === undefined &&
    h === undefined &&
    min === undefined &&
    s === undefined
  ) {
    return null;
  }
  return (
    Number(d ?? 0) * 86400 +
    Number(h ?? 0) * 3600 +
    Number(min ?? 0) * 60 +
    Number(s ?? 0)
  );
}

/** 75 → "1:15", 3725 → "1:02:05", 0 → "0:00". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
