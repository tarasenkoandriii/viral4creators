import { estimateCost } from '../../common/ai-pricing';
/** Pilot has audio+static art only. Animation is NOT submitted by this quote. */
export function storyAudioReservation(text: string): number {
  const tts = estimateCost('resemble-tts', { characters: text.length + 80 });
  if (tts.unpriced) throw new Error('Story TTS rate unavailable');
  // Conservative reserve, not a provider invoice: 4x internal TTS estimate,
  // plus $0.02 for one bounded Soniox QA. No implicit retries.
  return Math.ceil(tts.costMicroUsd * 4 + 20_000);
}
