import { isOwnBlobHost, isOwnBlobUrl } from './blob-url';

const OWN = 'https://store1.public.blob.vercel-storage.com';

describe('isOwnBlobUrl (этап 38, А-2.11)', () => {
  it('наш блоб под нашим префиксом проходит', () => {
    for (const p of [
      'sessions/s1/generated.mp4',
      'projects/p1/items/i1/photo.jpg',
      'brand-manifests/bm1/characters/c1/photo.png',
      'library/youtube-abc/previews/scene-1.jpg',
    ]) {
      expect(isOwnBlobUrl(`${OWN}/${p}`, {})).toBe(true);
    }
  });

  it('чужой хост с идеально правильным путём НЕ проходит', () => {
    // Ровно этот случай и был дырой: путь можно написать любой, а вот
    // заставить сервер сходить по адресу — уже нельзя.
    expect(
      isOwnBlobUrl(
        'https://internal.service/brand-manifests/bm1/photo.jpg',
        {},
      ),
    ).toBe(false);
    expect(isOwnBlobUrl('https://169.254.169.254/sessions/x.jpg', {})).toBe(
      false,
    );
    expect(isOwnBlobUrl('https://localhost:8080/sessions/x.jpg', {})).toBe(
      false,
    );
  });

  it('наш хост, но путь вне наших префиксов — тоже нет', () => {
    expect(isOwnBlobUrl(`${OWN}/../etc/passwd`, {})).toBe(false);
    expect(isOwnBlobUrl(`${OWN}/anything-else/x.jpg`, {})).toBe(false);
  });

  it('только https', () => {
    // http открывает подмену на пути; остальные схемы нам не нужны вовсе.
    expect(
      isOwnBlobUrl(
        'http://store1.public.blob.vercel-storage.com/sessions/x.jpg',
        {},
      ),
    ).toBe(false);
    expect(isOwnBlobUrl('file:///etc/passwd', {})).toBe(false);
    expect(isOwnBlobUrl('data:image/png;base64,AAAA', {})).toBe(false);
  });

  it('мусор вместо адреса не роняет проверку', () => {
    for (const bad of ['', '   ', 'не адрес', null, undefined]) {
      expect(isOwnBlobUrl(bad, {})).toBe(false);
    }
  });

  it('похожий домен не считается своим', () => {
    // `.public.blob.vercel-storage.com.зло.рф` заканчивается не на тот
    // суффикс — проверка идёт по концу хоста, а не по вхождению.
    expect(
      isOwnBlobUrl(
        'https://x.public.blob.vercel-storage.com.evil.example/sessions/x.jpg',
        {},
      ),
    ).toBe(false);
  });

  it('стенд может добавить свой хост переменной', () => {
    const env = { BLOB_PUBLIC_HOSTS: 'blob.test, cdn.example.com' };
    expect(isOwnBlobUrl('https://blob.test/sessions/s1/x.mp4', env)).toBe(true);
    expect(isOwnBlobUrl('https://cdn.example.com/projects/p/x.jpg', env)).toBe(
      true,
    );
    expect(isOwnBlobUrl('https://other.example/sessions/x.jpg', env)).toBe(
      false,
    );
  });

  it('пустая переменная не отключает проверку', () => {
    // «Выключить проверку одной пустой переменной» — тот же дефект,
    // только с рычагом.
    for (const env of [
      {},
      { BLOB_PUBLIC_HOSTS: '' },
      { BLOB_PUBLIC_HOSTS: ',,' },
    ]) {
      expect(isOwnBlobUrl('https://evil.example/sessions/x.jpg', env)).toBe(
        false,
      );
    }
  });

  it('хост сверяется без учёта регистра', () => {
    expect(isOwnBlobHost('Store1.Public.Blob.Vercel-Storage.Com', {})).toBe(
      true,
    );
  });
});
