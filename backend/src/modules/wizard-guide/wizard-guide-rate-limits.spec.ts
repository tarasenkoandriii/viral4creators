import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { RATE_LIMIT_KEY, RateLimitGuard } from '../../common/rate-limit';
import { WizardGuideController } from './wizard-guide.controller';

/**
 * Сторож декораторов платных ручек советника (финальный аудит ветки K,
 * 30.09.2026, изменение контракта 3): подсказка и её озвучка — под
 * ограничителем частоты ПО ЧЕЛОВЕКУ (за одним адресом мини-аппа сидит
 * весь оператор связи), а озвучка — `POST` с ключом в теле. Исчезнуть
 * при рефакторинге может именно строчка декоратора — молча.
 */
type Rule = { name: string; limit: number; windowSec: number; by?: string };

const HANDLERS: Array<[string, (...a: never[]) => unknown]> = [
  ['hint', WizardGuideController.prototype.hint],
  ['hint-audio', WizardGuideController.prototype.hintAudio],
];

describe('советник: платные ручки под ограничителем по человеку', () => {
  it.each(HANDLERS)('%s: гвард и оба окна by: user', (_name, handler) => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[];
    expect(guards).toContain(RateLimitGuard);
    const rules = Reflect.getMetadata(RATE_LIMIT_KEY, handler) as Rule[];
    expect(rules.map((r) => r.windowSec).sort((a, b) => a - b)).toEqual([
      60, 3600,
    ]);
    for (const r of rules) expect(r.by).toBe('user');
    expect(new Set(rules.map((r) => r.name)).size).toBe(rules.length);
  });

  it('озвучка — POST hint-audio (ключ в теле, не в строке запроса)', () => {
    const handler = WizardGuideController.prototype.hintAudio;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('hint-audio');
  });

  it('у озвучки своё окно, не общее с подсказкой', () => {
    const names = (h: (...a: never[]) => unknown) =>
      (Reflect.getMetadata(RATE_LIMIT_KEY, h) as Rule[]).map((r) => r.name);
    const hint = names(WizardGuideController.prototype.hint);
    for (const n of names(WizardGuideController.prototype.hintAudio)) {
      expect(hint).not.toContain(n);
    }
  });
});
