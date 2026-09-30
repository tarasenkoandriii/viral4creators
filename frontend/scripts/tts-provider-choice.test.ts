// Plain assertions runnable with `npx tsx scripts/tts-provider-choice.test.ts`.
//
// Контракт S-FE (Soniox): явный выбор провайдера голоса в бренд-буке,
// снимке мастера и переозвучке.

import {
  allowsDefaultVoice,
  effectiveProvider,
  hasSynthesisVoice,
  lacksWordTiming,
  parseExplicitProvider,
  savedProviderTag,
  showProviderMismatch,
} from '../src/lib/tts-provider-choice';

let failed = 0;
let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(a: unknown, b: unknown) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}

check('тег сервера → значение селектора', () => {
  eq(parseExplicitProvider('elevenlabs'), 'elevenlabs');
  eq(parseExplicitProvider('resemble'), 'resemble');
  eq(parseExplicitProvider('soniox'), 'soniox');
});

check('не провайдер синтеза — «по умолчанию»', () => {
  eq(parseExplicitProvider('veo'), null);
  eq(parseExplicitProvider(''), null);
  eq(parseExplicitProvider(null), null);
  eq(parseExplicitProvider(undefined), null);
});

check('голос по умолчанию есть только у Soniox', () => {
  eq(allowsDefaultVoice('soniox'), true);
  eq(allowsDefaultVoice('elevenlabs'), false);
  eq(allowsDefaultVoice('resemble'), false);
  eq(allowsDefaultVoice(null), false);
});

check('озвучить можно: выбран голос или Soniox без голоса', () => {
  eq(hasSynthesisVoice('v1', 'elevenlabs'), true);
  eq(hasSynthesisVoice('v1', undefined), true);
  eq(hasSynthesisVoice('', 'soniox'), true);
  eq(hasSynthesisVoice('   ', 'soniox'), true);
});

check('без голоса у ElevenLabs/Resemble/дефолта озвучить нечем', () => {
  eq(hasSynthesisVoice('', 'elevenlabs'), false);
  eq(hasSynthesisVoice('  ', 'resemble'), false);
  eq(hasSynthesisVoice('', null), false);
});

check('тег к сохранению: Soniox без голоса сохраняется', () => {
  eq(savedProviderTag('soniox', ''), 'soniox');
  eq(savedProviderTag('soniox', 'Maya'), 'soniox');
});

check('тег к сохранению: без голоса у прочих — null', () => {
  eq(savedProviderTag('elevenlabs', ''), null);
  eq(savedProviderTag('resemble', ' '), null);
  eq(savedProviderTag('elevenlabs', 'v1'), 'elevenlabs');
  eq(savedProviderTag(null, 'v1'), null);
});

const mismatch = {
  explicitProvider: null,
  voiceId: 'v1',
  voiceProvider: 'resemble',
  catalogueProvider: 'elevenlabs',
};

check('рассинхрон голоса и каталога без явного тега — предупреждаем', () => {
  eq(showProviderMismatch(mismatch), true);
});

check('явный тег — предупреждения нет', () => {
  eq(showProviderMismatch({ ...mismatch, explicitProvider: 'soniox' }), false);
});

check('нет рассинхрона или данных — молчим', () => {
  eq(
    showProviderMismatch({ ...mismatch, catalogueProvider: 'resemble' }),
    false
  );
  eq(showProviderMismatch({ ...mismatch, voiceId: '' }), false);
  eq(showProviderMismatch({ ...mismatch, voiceProvider: null }), false);
  eq(showProviderMismatch({ ...mismatch, catalogueProvider: '' }), false);
});

check('пометка о тайминге: явный Soniox', () => {
  eq(lacksWordTiming('soniox', 'elevenlabs'), true);
});

check('пометка о тайминге: Soniox активен на стенде, явного нет', () => {
  eq(lacksWordTiming(null, 'soniox'), true);
});

check('пометка о тайминге: явный другой провайдер перекрывает стенд', () => {
  eq(lacksWordTiming('elevenlabs', 'soniox'), false);
  eq(lacksWordTiming(null, 'resemble'), false);
  eq(lacksWordTiming(undefined, undefined), false);
});

check('действующий провайдер: явный выбор главнее тега', () => {
  eq(effectiveProvider('elevenlabs', 'soniox'), 'elevenlabs');
});

check('действующий провайдер: без выбора — сохранённый тег', () => {
  eq(effectiveProvider(null, 'soniox'), 'soniox');
  eq(effectiveProvider(undefined, 'resemble'), 'resemble');
});

check('действующий провайдер: тег не провайдер синтеза — null', () => {
  eq(effectiveProvider(null, 'veo'), null);
  eq(effectiveProvider(null, null), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
