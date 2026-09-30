/**
 * Голос переозвучки у поздравления: у сессии без брендбука, но со
 * снимком брифа панель «Постпрод» не выбирает провайдера и голос
 * (`PATCH brand-manifest` у поздравления отвечает 404), а называет
 * голос из снимка. Порядок — как у `senderVoiceKind` и `planWork`:
 * клон, пресет, Soniox.
 */
import assert from 'node:assert/strict';
import {
  greetingRevoiceVoice,
  greetingVoiceCaption,
} from '../src/lib/revoice-greeting-voice';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const clone = {
  userVoiceId: 'uv1',
  resembleVoiceId: 'rv1',
  label: 'Голос мамы',
};

console.log('revoice-greeting-voice');

it('брендбук есть — прежний выбор голоса (null), даже со снимком брифа', () => {
  assert.equal(
    greetingRevoiceVoice({
      hasBrandSnapshot: true,
      greetingBriefSnapshot: { senderVoice: clone },
    }),
    null
  );
});

it('ни брендбука, ни снимка брифа — не поздравление (null)', () => {
  for (const snap of [null, undefined, 'x', 42, []]) {
    assert.equal(
      greetingRevoiceVoice({
        hasBrandSnapshot: false,
        greetingBriefSnapshot: snap,
      }),
      null
    );
  }
});

it('ЭТО И БЫЛА ОШИБКА: поздравление с клоном — голос из снимка, не выбор', () => {
  assert.deepEqual(
    greetingRevoiceVoice({
      hasBrandSnapshot: false,
      greetingBriefSnapshot: { senderVoice: clone },
    }),
    { kind: 'clone', label: 'Голос мамы' }
  );
});

it('клон побеждает пресет и Soniox в противоречивой записи', () => {
  assert.deepEqual(
    greetingRevoiceVoice({
      hasBrandSnapshot: false,
      greetingBriefSnapshot: {
        senderVoice: clone,
        presetVoiceId: 'ara',
        sonioxVoice: { voiceId: 'Maya', label: 'Maya' },
      },
    }),
    { kind: 'clone', label: 'Голос мамы' }
  );
});

it('клон без подписи — подпись из id, а не пустая строка', () => {
  assert.deepEqual(
    greetingRevoiceVoice({
      hasBrandSnapshot: false,
      greetingBriefSnapshot: { senderVoice: { ...clone, label: '  ' } },
    }),
    { kind: 'clone', label: 'rv1' }
  );
});

it('пресет побеждает Soniox', () => {
  assert.deepEqual(
    greetingRevoiceVoice({
      hasBrandSnapshot: false,
      greetingBriefSnapshot: {
        senderVoice: null,
        presetVoiceId: ' ara ',
        sonioxVoice: { voiceId: 'Maya', label: 'Maya' },
      },
    }),
    { kind: 'preset', voiceId: 'ara' }
  );
});

it('Soniox: имя из label, иначе voiceId, иначе «по умолчанию»', () => {
  const soniox = (v: unknown) =>
    greetingRevoiceVoice({
      hasBrandSnapshot: false,
      greetingBriefSnapshot: { senderVoice: null, sonioxVoice: v },
    });
  assert.deepEqual(soniox({ voiceId: 'Maya', label: 'Maya (F)' }), {
    kind: 'soniox',
    label: 'Maya (F)',
  });
  assert.deepEqual(soniox({ voiceId: 'Adrian', label: null }), {
    kind: 'soniox',
    label: 'Adrian',
  });
  assert.deepEqual(soniox({ voiceId: null, label: null }), {
    kind: 'soniox',
    label: null,
  });
});

it('голос не выбран — голос по умолчанию', () => {
  assert.deepEqual(
    greetingRevoiceVoice({
      hasBrandSnapshot: false,
      greetingBriefSnapshot: {
        senderVoice: null,
        presetVoiceId: '',
        sonioxVoice: null,
      },
    }),
    { kind: 'default' }
  );
  assert.deepEqual(
    greetingRevoiceVoice({
      hasBrandSnapshot: false,
      greetingBriefSnapshot: {},
    }),
    { kind: 'default' }
  );
});

const labels = {
  greetingVoiceClone: 'свой «{label}»',
  greetingVoicePreset: 'Grok ({label})',
  greetingVoiceSoniox: 'Soniox {label}',
  greetingVoiceSonioxDefault: 'Soniox по умолчанию',
  greetingVoiceDefault: 'по умолчанию',
};

it('подпись называет каждый вид своей строкой', () => {
  assert.equal(
    greetingVoiceCaption({ kind: 'clone', label: 'Мама' }, labels),
    'свой «Мама»'
  );
  assert.equal(
    greetingVoiceCaption({ kind: 'preset', voiceId: 'ara' }, labels),
    'Grok (ara)'
  );
  assert.equal(
    greetingVoiceCaption({ kind: 'soniox', label: 'Maya' }, labels),
    'Soniox Maya'
  );
  assert.equal(
    greetingVoiceCaption({ kind: 'soniox', label: null }, labels),
    'Soniox по умолчанию'
  );
  assert.equal(
    greetingVoiceCaption({ kind: 'default' }, labels),
    'по умолчанию'
  );
});

console.log(`  ${passed} passed`);
