/** Content correspondence, not a guarantee of natural prosody or pronunciation. */
export function storySpeechScore(reference: string, recognized: string) {
  const words = (s: string) =>
    s
      .normalize('NFKC')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const ref = words(reference),
    hyp = words(recognized);
  let previous = Array.from({ length: hyp.length + 1 }, (_, i) => i);
  for (let i = 1; i <= ref.length; i++) {
    const next = [i];
    for (let j = 1; j <= hyp.length; j++)
      next[j] = Math.min(
        previous[j] + 1,
        next[j - 1] + 1,
        previous[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    previous = next;
  }
  return {
    referenceWords: ref.length,
    recognizedWords: hyp.length,
    wer: ref.length ? previous[hyp.length] / ref.length : 1,
  };
}
