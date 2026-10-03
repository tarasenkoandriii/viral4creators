import type { VoiceControlDictionary } from './voice-control-ru';

export const voiceControlEn: VoiceControlDictionary = {
  title: 'Voice control of the site',
  intro:
    'A visitor says “open delivery” or “add the blue one, size M, to the cart” — the assistant scrolls, presses and fills in fields on your site by itself, in front of the visitor. Steps that change anything happen only after their “Yes”. Off by default.',
  toggle: 'The assistant presses buttons for the visitor',
  needVoice: 'First turn on the microphone in the “Voice” section above.',
  plan: 'Voice control is available on plans with voice (Business and above).',
  reasons: {
    platform_off: 'Voice control is temporarily disabled on the platform.',
    voice_off: 'The microphone is off — visitors cannot give voice commands.',
    state_off: 'Off.',
    rules_invalid: 'The rules are corrupted — save them again.',
  },
  risks: {
    title: 'Before you turn it on — the risks',
    items: [
      'The assistant may press the wrong thing (similar buttons, a changed layout). It highlights the element before pressing, checks the result and stops on “stop”, Esc or the visitor’s own click.',
      'Payments, deletion, placing orders, cancelling subscriptions, entering passwords and cards, going to another domain — never; the assistant highlights it and asks the visitor to press it.',
      'Submitting forms and fields with personal data — only after the visitor’s “Yes”.',
      'Some anti-bot and anti-fraud systems dislike synthetic clicks (isTrusted = false) — test your site before enabling.',
      'Button and link labels are personal data too: e-mails and phones are masked, but add a clause to your privacy policy and data-assist="never" on areas with personal data.',
      'We are responsible for enforcing the prohibitions in code and keep a step log; liability is limited to the fees paid.',
    ],
    accept: 'I have read the risks and turn voice control on',
  },
  rules: {
    title: 'Rules',
    allowPaths: 'Allowed pages (masks, one per line; empty — the whole site)',
    denyPaths: 'Forbidden pages (masks, e.g. /account*)',
    denySelectors: 'Forbidden elements (CSS selectors)',
    allowSelectors: 'Allowed areas (CSS selectors; empty — the whole page)',
    denyWords: 'Forbidden words in button labels',
    confirmFill: 'Ask for confirmation for filling in fields too',
    maxSteps: 'Steps per command (up to 15)',
    markup:
      'Markup is the most reliable: data-assist-id="add-to-cart" on the “Add to cart” button, data-assist="never" on areas the assistant must not touch.',
  },
  save: 'Save',
  saved: 'Saved.',
  errors: {
    VOICE_CONTROL_INVALID:
      'The rules did not pass validation — fix the highlighted lines.',
    VOICE_CONTROL_PLAN_REQUIRED:
      'A plan with voice is required (Business and above).',
    VOICE_CONTROL_VOICE_REQUIRED:
      'First turn on the microphone in the “Voice” section.',
    VOICE_CONTROL_RISKS_REQUIRED: 'Confirm that you have read the risks.',
  },
};
