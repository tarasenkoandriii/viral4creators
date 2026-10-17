/** Accepted Greeting performance recipe, shared with Tutorial. v1 is immutable in intent. */
export const TUTORIAL_GREETING_PERFORMANCE_PROFILE =
  'greeting-tutorial-v1' as const;

export function presenterPerformancePrompt(
  context: string,
  tone: string,
): string {
  return [
    `A personal video message for ${context}, tone: ${tone}.`,
    'Preserve the person, outfit, lighting and setting of the source portrait.',
    'Use the supplied audio as the sole timing reference. Articulate the actual spoken phonemes naturally; do not add dialogue.',
    'Locked camera. Keep a balanced, relaxed seated posture; do not freeze the torso. Keep hands resting still in the lap, below the chest and preferably below the frame, throughout the message.',
    'Do not raise the hands or add a greeting gesture. No continuous arm waving, repeated open palms, swaying, dancing or rocking.',
    'Keep the performance alive through visible gentle breathing and relaxed shoulder movement. Make one small natural posture adjustment at a sentence boundary, with a slight forward engagement on a warm wish, then settle back. Use small head accents on spoken emphasis and return to neutral during pauses. Maintain focused, warm eye contact; blink occasionally, not repeatedly or with half-closed eyes. Let the smile and eyebrows respond naturally to the meaning, without a fixed smile through every syllable.',
    'During every audible pause, stop articulating and rest the lips naturally. After the final spoken syllable, close the mouth into a soft smile and keep it closed until the clip ends. Let the delivery follow the audio pauses and end calmly with the final spoken phrase. No on-screen text.',
  ].join(' ');
}

/** Same performance instructions; only the message context differs. */
export function tutorialPresenterPerformancePrompt(): string {
  return presenterPerformancePrompt('TUTORIAL', 'WARM');
}

/** Separate experiment: v1 and the accepted Greeting remain immutable. */
export const TUTORIAL_PREAMBLE_PROFILE_V2 = 'tutorial-preamble-v2' as const;
export function tutorialPreamblePromptV2(): string {
  return [
    'A clear, warm product tutorial introduction, delivered naturally to the viewer.',
    'Preserve the exact person, outfit, background, lighting and camera framing from the source portrait. Locked camera. No cuts, zooms, relighting or changes to the scene.',
    'The supplied speech audio is the sole timing reference. Speak only its actual words. Prioritize accurate, natural articulation over extra movement; do not stretch speech movements across pauses.',
    'Keep the hands resting below the frame. Do not prescribe or exaggerate breathing, swaying, posture changes or gestures. Small spontaneous head movements are enough.',
    'Use attentive, relaxed eye contact and a neutral-friendly expression matching an explanation, not a festive wish. Do not hold a broad smile while articulating. Blink naturally.',
    'Rest the lips during audible pauses. After the last spoken syllable, close the mouth naturally and remain calm. No added dialogue, text or visual effects.',
  ].join(' ');
}
