import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { YoutubeSearchQueryDto } from './youtube-search-query.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const run = (v: unknown) =>
  pipe.transform(v, {
    type: 'query',
    metatype: YoutubeSearchQueryDto,
    data: '',
  });
const ok = (v: unknown) => expect(run(v)).resolves.toBeDefined();
const bad = (v: unknown) =>
  expect(run(v)).rejects.toBeInstanceOf(BadRequestException);

describe('YoutubeSearchQueryDto', () => {
  it('requires q (1–200) and accepts optional region/language', async () => {
    await ok({ q: 'кроссовки' });
    await ok({ q: 'shoes', regionCode: 'UA', language: 'uk' });
    await ok({ q: 'shoes', regionCode: 'br', language: 'pt-BR' });
    await bad({});
    await bad({ q: '' });
    await bad({ q: 'x'.repeat(201) });
  });

  it('rejects malformed region/language and unknown params', async () => {
    await bad({ q: 'shoes', regionCode: 'UKR' });
    await bad({ q: 'shoes', regionCode: '1A' });
    await bad({ q: 'shoes', language: 'u' });
    await bad({ q: 'shoes', language: 'uk_UA' });
    await bad({ q: 'shoes', maxResults: '5' });
    await bad({ q: 'shoes', pageToken: 'abc' });
  });
});
