import { ValidationPipe, BadRequestException } from '@nestjs/common';
import {
  CreatePublicationRequestDto,
  RejectPublicationRequestDto,
} from './publication.dto';

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

describe('publication DTOs', () => {
  it('create: platform enum, optional title ≤100 / description / tags', async () => {
    await ok(CreatePublicationRequestDto, { platform: 'YOUTUBE' });
    await ok(CreatePublicationRequestDto, {
      platform: 'TIKTOK',
      title: 'Заголовок',
      description: 'd',
      tags: ['a', 'b'],
    });
    await bad(CreatePublicationRequestDto, {});
    await bad(CreatePublicationRequestDto, { platform: 'INSTAGRAM' });
    await bad(CreatePublicationRequestDto, {
      platform: 'YOUTUBE',
      title: 'x'.repeat(101),
    });
    await bad(CreatePublicationRequestDto, { platform: 'YOUTUBE', tags: 'a' });
    await bad(CreatePublicationRequestDto, {
      platform: 'YOUTUBE',
      status: 'APPROVED',
    });
  });
  it('reject: reason 3–1000', async () => {
    await ok(RejectPublicationRequestDto, { reason: 'логотип конкурента' });
    await bad(RejectPublicationRequestDto, { reason: 'x' });
    await bad(RejectPublicationRequestDto, {});
  });
});
