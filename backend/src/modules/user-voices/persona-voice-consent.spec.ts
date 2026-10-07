/**
 * Шов «текст фразы согласия = её версия» (LEGAL-GATE-Persona §2.1 п.4,
 * заход 8, C10).
 *
 * В `UserVoice.consentPhraseVersion` пишется редакция фразы, которую
 * человек произнёс в начале записи голоса персоны. Версия что-то значит,
 * только если один и тот же номер — всегда один и тот же текст: поправили
 * формулировку и забыли поднять `PERSONA_VOICE_CONSENT_VERSION` — и у
 * новых записей в базе окажется версия, под которой человек произносил
 * другие слова, а клиенты со старой фразой продолжат проходить проверку
 * сервера.
 *
 * Поэтому текст всех пяти редакций закреплён хешем ЗА ВЕРСИЕЙ. Поменяли
 * текст — тест падает; чинится он только парой правок: новая
 * `PERSONA_VOICE_CONSENT_VERSION` (дата) и новый хеш здесь. Поменять
 * только хеш, оставив версию, — ровно то, от чего шов и стоит: строка
 * ниже требует, чтобы у каждой версии был ровно один хеш за всю историю.
 */

import { createHash } from 'crypto';
import { SUPPORTED_LOCALES } from '../../common/locale';
import {
  PERSONA_VOICE_CONSENT_VERSION,
  personaVoiceConsentPhrase,
} from './persona-voice-consent';

/**
 * История редакций: версия → sha256 шаблонов всех локалей. Строки только
 * ДОБАВЛЯЮТСЯ — прежние остаются, чтобы версию нельзя было «переиспользовать»
 * с другим текстом.
 */
const HISTORY: Record<string, string> = {
  '2026-09-30':
    '362ddd2c7ee130d16b9589d44a97fbc7b77d1479340280d4f78500cd723ca8a5',
};

function phrasesHash(): string {
  const all = SUPPORTED_LOCALES.map(
    (loc) => `${loc}\t${personaVoiceConsentPhrase(loc).template}`,
  ).join('\n');
  return createHash('sha256').update(all).digest('hex');
}

describe('фраза согласия голоса персоны: текст закреплён за версией', () => {
  it('текст фразы не менялся без новой версии', () => {
    const expected = HISTORY[PERSONA_VOICE_CONSENT_VERSION];
    if (!expected) {
      throw new Error(
        `Версии ${PERSONA_VOICE_CONSENT_VERSION} нет в HISTORY — добавьте строку ` +
          `'${PERSONA_VOICE_CONSENT_VERSION}': '${phrasesHash()}'`,
      );
    }
    if (phrasesHash() !== expected) {
      throw new Error(
        'Текст фразы согласия изменился, а PERSONA_VOICE_CONSENT_VERSION — нет. ' +
          'Поднимите версию (дата правки) и добавьте её с новым хешем в HISTORY; ' +
          'прежние строки HISTORY не трогайте.',
      );
    }
  });

  it('у каждого хеша одна версия: новую версию не выдать за старый текст и наоборот', () => {
    const hashes = Object.values(HISTORY);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('версия — дата редакции', () => {
    for (const v of Object.keys(HISTORY)) {
      expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('каждая локаль — своя фраза с местом для имени', () => {
    const templates = SUPPORTED_LOCALES.map(
      (loc) => personaVoiceConsentPhrase(loc).template,
    );
    expect(new Set(templates).size).toBe(SUPPORTED_LOCALES.length);
    for (const t of templates) expect(t).toContain('{name}');
  });
});
