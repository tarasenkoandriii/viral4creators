import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RATE_LIMIT_KEY, RateLimitGuard } from '../../common/rate-limit';
import { GreetingVoiceController } from './greeting-voice.controller';
import { ProjectGreetingVoiceController } from './project-greeting-voice.controller';

/**
 * Сторож декораторов (аудит волны K): каждая голосовая ручка — ссылка на
 * загрузку или платная обработка — стоит под ограничителем частоты. Гвард
 * проверен своим тестом; исчезнуть при рефакторинге может именно строчка
 * декоратора — молча и без единого падающего теста.
 */
type Rule = { name: string; limit: number; windowSec: number; by?: string };

const HANDLERS: Array<[string, (...a: never[]) => unknown]> = [
  ['sessions upload-url', GreetingVoiceController.prototype.createUploadUrl],
  ['sessions transcribe', GreetingVoiceController.prototype.transcribe],
  ['sessions understand', GreetingVoiceController.prototype.understand],
  [
    'projects upload-url',
    ProjectGreetingVoiceController.prototype.createUploadUrl,
  ],
  ['projects understand', ProjectGreetingVoiceController.prototype.understand],
];

describe('голосовые маршруты под ограничителем частоты', () => {
  it.each(HANDLERS)('%s: гвард и два окна по человеку', (_name, handler) => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[];
    expect(guards).toContain(RateLimitGuard);
    const rules = Reflect.getMetadata(RATE_LIMIT_KEY, handler) as Rule[];
    const minute = rules.find((r) => r.windowSec === 60)!;
    const hour = rules.find((r) => r.windowSec === 3600)!;
    expect(minute).toMatchObject({ limit: 20, by: 'user' });
    expect(hour).toMatchObject({ limit: 300, by: 'user' });
    expect(new Set(rules.map((r) => r.name)).size).toBe(rules.length);
  });

  it('расшифровка и разбор делят одно окно — чередованием лимит не удвоить', () => {
    const names = (h: (...a: never[]) => unknown) =>
      (Reflect.getMetadata(RATE_LIMIT_KEY, h) as Rule[]).map((r) => r.name);
    expect(names(GreetingVoiceController.prototype.transcribe)).toEqual(
      names(GreetingVoiceController.prototype.understand),
    );
    expect(names(ProjectGreetingVoiceController.prototype.understand)).toEqual(
      names(GreetingVoiceController.prototype.understand),
    );
  });
});
