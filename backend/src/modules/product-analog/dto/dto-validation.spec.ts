import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { PhotoUploadUrlRequestDto } from './photo-upload-url-request.dto';
import { ProcessPhotoRequestDto } from './process-photo-request.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (metatype: any, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype, data: '' });

describe('photo DTOs under the real ValidationPipe settings', () => {
  it('upload-url accepts the product-image contract and rejects >10MB / bad mime / extras', async () => {
    await expect(
      run(PhotoUploadUrlRequestDto, {
        fileName: 'a.jpg',
        fileSize: 1024,
        mimeType: 'image/jpeg',
      }),
    ).resolves.toBeDefined();
    await expect(
      run(PhotoUploadUrlRequestDto, {
        fileName: 'a.jpg',
        fileSize: 20_000_000,
        mimeType: 'image/jpeg',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(PhotoUploadUrlRequestDto, {
        fileName: 'a.gif',
        fileSize: 10,
        mimeType: 'image/gif',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(PhotoUploadUrlRequestDto, {
        fileName: 'a.jpg',
        fileSize: 10,
        mimeType: 'image/jpeg',
        pathname: 'x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('process accepts only an item photo pathname', async () => {
    await expect(
      run(ProcessPhotoRequestDto, {
        pathname: 'projects/p1/items/i1/photo.jpg',
      }),
    ).resolves.toBeDefined();
    await expect(
      run(ProcessPhotoRequestDto, {
        pathname: 'projects/p1/items/i1/photo.webp',
      }),
    ).resolves.toBeDefined();
    for (const bad of [
      'sessions/s1/product-image.jpg',
      'projects/p1/items/i1/other.jpg',
      '../../etc/passwd',
      'projects/p1/items/i1/photo.gif',
      '',
    ]) {
      await expect(
        run(ProcessPhotoRequestDto, { pathname: bad }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
