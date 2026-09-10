/**
 * DTO behaviour under the app's REAL global ValidationPipe settings
 * (main.ts: whitelist + forbidNonWhitelisted + transform). This is the
 * exact class of bug that bit DevLoginDto ("property X should not exist")
 * — a field without a class-validator decorator is treated as unknown —
 * so every DTO field is exercised here, plus the fields that must be
 * REJECTED because other flows own them (currency, category, photoUrl).
 */
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { CreateProjectRequestDto } from './create-project-request.dto';
import { UpdateProjectRequestDto } from './update-project-request.dto';
import { ProductItemRequestDto } from './product-item-request.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (metatype: any, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype, data: '' });
/**
 * Отказ с ожидаемым текстом.
 *
 * Раньше сообщение проверялось внутри `.catch(...)` (Б-5.20): если DTO
 * перестанет отвергать значение, коллбек просто не выполнится, и тест
 * останется зелёным, ничего не проверив. Теперь ошибка достаётся
 * `rejects`, а `expect` живёт в прямом потоке — как того и требует
 * включённое правило `jest/no-conditional-expect`.
 */
const rejects = async (metatype: unknown, value: unknown, re: RegExp) => {
  const error: unknown = await run(metatype, value).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  const msg = JSON.stringify((error as BadRequestException).getResponse());
  expect(msg).toMatch(re);
};

describe('CreateProjectRequestDto', () => {
  it('accepts a valid body', async () => {
    const dto = await run(CreateProjectRequestDto, {
      type: 'LINE',
      title: 'Кроссовки',
      countryCode: 'UA',
    });
    expect(dto).toBeInstanceOf(CreateProjectRequestDto);
  });
  it('accepts optional brandManifestId', async () => {
    await expect(
      run(CreateProjectRequestDto, {
        type: 'SINGLE',
        title: 'x',
        countryCode: 'PL',
        brandManifestId: 'bm1',
      }),
    ).resolves.toBeDefined();
  });
  it('rejects a client-supplied currency (derived server-side, §7.2)', () =>
    rejects(
      CreateProjectRequestDto,
      { type: 'LINE', title: 'x', countryCode: 'UA', currency: 'USD' },
      /currency should not exist/,
    ));
  it('rejects a bad type', () =>
    rejects(
      CreateProjectRequestDto,
      { type: 'TRIPLE', title: 'x', countryCode: 'UA' },
      /SINGLE.*LINE/,
    ));
  it('rejects a non-2-letter country', () =>
    rejects(
      CreateProjectRequestDto,
      { type: 'LINE', title: 'x', countryCode: 'UKR' },
      /2-letter ISO/,
    ));
  it('rejects an empty title', () =>
    rejects(
      CreateProjectRequestDto,
      { type: 'LINE', title: '', countryCode: 'UA' },
      /title must be between/,
    ));
});

describe('UpdateProjectRequestDto', () => {
  it('accepts an empty body (no-op PATCH)', async () => {
    await expect(run(UpdateProjectRequestDto, {})).resolves.toBeDefined();
  });
  it('accepts brandManifestId: null (detach)', async () => {
    const dto = await run(UpdateProjectRequestDto, { brandManifestId: null });
    expect(dto.brandManifestId).toBeNull();
  });
  it('rejects a non-string brandManifestId', () =>
    rejects(
      UpdateProjectRequestDto,
      { brandManifestId: 42 },
      /brandManifestId/,
    ));
});

describe('ProductItemRequestDto', () => {
  it('accepts an empty draft (§7.4: nothing required to save)', async () => {
    await expect(run(ProductItemRequestDto, {})).resolves.toBeDefined();
  });
  it('accepts a full body', async () => {
    const dto = await run(ProductItemRequestDto, {
      title: 'Размер 42',
      description: 'd',
      price: 1999.99,
      priceSource: 'ANALOG',
    });
    expect(dto.price).toBe(1999.99);
  });
  it('accepts null to clear fields', async () => {
    const dto = await run(ProductItemRequestDto, {
      price: null,
      description: null,
      title: null,
    });
    expect(dto).toMatchObject({ price: null, description: null, title: null });
  });
  it('rejects a price with 3 decimals (column is DECIMAL(12,2))', () =>
    rejects(ProductItemRequestDto, { price: 1.999 }, /2 decimal/));
  it('audience (§18): nested object or null; bad gender / unknown keys rejected', async () => {
    await expect(
      run(ProductItemRequestDto, {
        audience: { ageRange: '25-34', gender: 'any', interests: ['бег'] },
      }),
    ).resolves.toBeDefined();
    await expect(
      run(ProductItemRequestDto, { audience: null }),
    ).resolves.toBeDefined();
    await rejects(
      ProductItemRequestDto,
      { audience: { gender: 'robots' } },
      /gender/,
    );
    await rejects(ProductItemRequestDto, { audience: { extra: 1 } }, /extra/);
  });
  it('rejects a negative price', () =>
    rejects(ProductItemRequestDto, { price: -1 }, />= 0/));
  it('rejects a string price (no implicit coercion)', () =>
    rejects(ProductItemRequestDto, { price: '10' }, /price must be a number/));
  it('rejects category — auto-detected, never user-entered (§9.4)', () =>
    rejects(
      ProductItemRequestDto,
      { category: 'shoes' },
      /category should not exist/,
    ));
  it('rejects photoUrl/photoHash — owned by the photo flow (Stage 4)', () =>
    rejects(
      ProductItemRequestDto,
      { photoUrl: 'https://x', photoHash: 'abc' },
      /photoUrl should not exist/,
    ));
  it('rejects an unknown priceSource', () =>
    rejects(ProductItemRequestDto, { priceSource: 'GUESS' }, /priceSource/));
});
