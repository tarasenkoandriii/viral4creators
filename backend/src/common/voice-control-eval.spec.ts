import {
  matchesControl,
  main,
} from '../../scripts/greeting-eval/voice-control';
import { VOICE_CONTROL_SET } from '../../scripts/greeting-eval/voice-control-set';
import type { VoiceUnderstandResult } from './greeting-voice-intent';
const result = (intent: unknown, status = 'ok') =>
  ({ status, intent }) as VoiceUnderstandResult;
describe('voice-control synthetic evaluation', () => {
  it('accepts the expected action, rejects another action or failed response', () => {
    expect(
      matchesControl(result({ kind: 'command', command: 'shorter' }), {
        kind: 'command',
        command: 'shorter',
      }),
    ).toBe(true);
    expect(
      matchesControl(
        result({ kind: 'command', command: 'regenerate-script' }),
        { kind: 'command', command: 'shorter' },
      ),
    ).toBe(false);
    expect(
      matchesControl(result({ kind: 'confirm' }, 'unknown'), {
        kind: 'confirm',
      }),
    ).toBe(false);
    expect(
      matchesControl(result({ kind: 'navigate', to: 'next' }), {
        kind: 'navigate',
        to: 'back',
      }),
    ).toBe(false);
  });
  it('requires the expected field and exact parsed value', () => {
    const r = result({
      kind: 'fill',
      fields: [{ target: 'greeting-field-date', value: '2027-03-12' }],
    });
    expect(
      matchesControl(r, {
        kind: 'fill',
        target: 'greeting-field-date',
        value: '2027-03-12',
      }),
    ).toBe(true);
    expect(
      matchesControl(r, {
        kind: 'fill',
        target: 'greeting-field-date',
        value: '2027-12-03',
      }),
    ).toBe(false);
  });
  it('includes an isolated Ukrainian negative response in provider acceptance', () => {
    expect(VOICE_CONTROL_SET).toContainEqual({
      id: 'uk-no',
      lang: 'uk',
      text: 'Ні',
      pending: true,
      kind: 'cancel',
    });
  });
  it('dry run needs no provider keys and makes no paid calls', async () => {
    expect(await main([])).toBe(0);
    await expect(main(['--max-usd=3'])).rejects.toThrow('Потолок');
    await expect(main(['--unexpected'])).rejects.toThrow('Неизвестный');
  });
});
