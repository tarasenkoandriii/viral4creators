/**
 * DTO этапа G (ТЗ Greeting 2.0 §4.7, §4.8, §4.9, Г-8) под настоящими
 * настройками глобального ValidationPipe (main.ts: whitelist +
 * forbidNonWhitelisted + transform): поле без декоратора отвергалось бы
 * как неизвестное — ровно тот класс ошибок, который ловят такие тесты.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateGreetingBriefDto } from '../project/dto/update-greeting-brief.dto';
import { CreateProjectRequestDto } from '../project/dto/create-project-request.dto';
import { BrandManifestRequestDto } from '../brand-manifest/dto/brand-manifest-request.dto';
import { GreetingReferenceUpdateRequestDto } from '../greeting-reference/dto/greeting-reference.dto';
import { CreateSharedVideoRequestDto } from '../shared-video/dto/shared-video.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (m: any, v: unknown) =>
  pipe.transform(v, { type: 'body', metatype: m, data: '' });
const ok = (m: unknown, v: unknown) => expect(run(m, v)).resolves.toBeDefined();
const bad = (m: unknown, v: unknown) =>
  expect(run(m, v)).rejects.toBeInstanceOf(BadRequestException);

describe('presenter в брифе', () => {
  it('ai и persona проходят; persona без образа или варианта — нет', async () => {
    await ok(UpdateGreetingBriefDto, { presenter: { kind: 'ai' } });
    await ok(UpdateGreetingBriefDto, {
      presenter: { kind: 'persona', lookId: 'l1', variant: 'photo' },
    });
    await ok(UpdateGreetingBriefDto, {
      presenter: { kind: 'persona', lookId: 'l1', variant: 'sketch' },
    });
    await bad(UpdateGreetingBriefDto, { presenter: { kind: 'persona' } });
    await bad(UpdateGreetingBriefDto, {
      presenter: { kind: 'persona', lookId: 'l1', variant: 'video' },
    });
    await bad(UpdateGreetingBriefDto, { presenter: { kind: 'celebrity' } });
    await bad(UpdateGreetingBriefDto, {
      presenter: { kind: 'ai', url: 'https://evil' },
    });
  });

  it('вложенный бриф при создании проекта тоже принимает presenter', async () => {
    await ok(CreateProjectRequestDto, {
      type: 'GREETING_VIDEO',
      title: 'Маме',
      countryCode: 'UA',
      greetingBrief: {
        occasion: 'BIRTHDAY',
        recipientName: 'Мама',
        presenter: { kind: 'persona', lookId: 'l1', variant: 'photo' },
      },
    });
    await bad(CreateProjectRequestDto, {
      type: 'GREETING_VIDEO',
      title: 'Маме',
      countryCode: 'UA',
      greetingBrief: {
        occasion: 'BIRTHDAY',
        recipientName: 'Мама',
        presenter: { kind: 'persona', variant: 'photo' },
      },
    });
  });
});

describe('бренд-бук: вид, образ, подпись, тон, стиль карточек', () => {
  it('допустимые значения и явные null', async () => {
    await ok(BrandManifestRequestDto, {
      title: 'Я',
      kind: 'PERSONAL',
      defaultLookId: 'l1',
      signature: 'Мама',
      defaultTone: 'WARM',
      cardStyle: { font: 'serif', color: 'gold' },
    });
    await ok(BrandManifestRequestDto, {
      defaultLookId: null,
      signature: null,
      defaultTone: null,
      cardStyle: null,
    });
  });
  it('вне белого списка — отказ; personaId клиент не ставит', async () => {
    await bad(BrandManifestRequestDto, { kind: 'FAMILY' });
    await bad(BrandManifestRequestDto, { defaultTone: 'ANGRY' });
    await bad(BrandManifestRequestDto, {
      cardStyle: { font: 'Comic Sans', color: 'gold' },
    });
    await bad(BrandManifestRequestDto, {
      cardStyle: { font: 'serif', color: '#000000' },
    });
    await bad(BrandManifestRequestDto, {
      cardStyle: { font: 'serif', color: 'gold', size: 90 },
    });
    await bad(BrandManifestRequestDto, { personaId: 'p-чужой' });
    await bad(BrandManifestRequestDto, { signature: 'x'.repeat(121) });
  });
});

describe('референс: согласие изображённого', () => {
  it('только true', async () => {
    await ok(GreetingReferenceUpdateRequestDto, { faceConsent: true });
    await bad(GreetingReferenceUpdateRequestDto, { faceConsent: false });
    await bad(GreetingReferenceUpdateRequestDto, { faceConsent: 'yes' });
    await bad(GreetingReferenceUpdateRequestDto, {
      faceConsentAt: '2026-01-01',
    });
  });
});

describe('публикация: галочка витрины для ролика с персоной', () => {
  it('булево', async () => {
    await ok(CreateSharedVideoRequestDto, { allowShowcaseWithPersona: true });
    await ok(CreateSharedVideoRequestDto, {});
    await bad(CreateSharedVideoRequestDto, {
      allowShowcaseWithPersona: 'yes',
    });
  });
});
