import {
  CAPTIONS_SCOPE,
  googleScopes,
  hasCaptionsScope,
} from './google-oauth.service';

/**
 * Права, которые продукт просит у Google (этап 137, ТЗ §4).
 *
 * Здесь проверяется граница, которую нельзя увидеть глазами и которая
 * стоит дорого в обе стороны: попросить лишнего — это право удалять
 * ролики на экране согласия у каждого клиента и лишний разговор с
 * Google на верификации; попросить недостаточно — субтитры молча не
 * работают.
 */
describe('googleScopes', () => {
  it('базовый набор — только загрузка и чтение канала', () => {
    expect(googleScopes(false)).toEqual([
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
    ]);
    expect(googleScopes(false)).not.toContain(CAPTIONS_SCOPE);
  });

  it('расширенный добавляет force-ssl, НЕ теряя базовых', () => {
    // Потеря базовых означала бы канал, который больше не грузит ролики,
    // — то есть расширение сломало бы то, ради чего канал подключали.
    expect(googleScopes(true)).toEqual([
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
      CAPTIONS_SCOPE,
    ]);
  });

  it('наборы не разделяют массив: правка одного не трогает другой', () => {
    const first = googleScopes(true);
    first.push('чужое');
    expect(googleScopes(false)).toHaveLength(2);
    expect(googleScopes(true)).toHaveLength(3);
  });
});

describe('hasCaptionsScope', () => {
  it('канал со старым согласием — false, с новым — true', () => {
    expect(
      hasCaptionsScope([
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube.readonly',
      ]),
    ).toBe(false);
    expect(hasCaptionsScope(googleScopes(true))).toBe(true);
  });

  it('пустой и отсутствующий список — false, а не падение', () => {
    // `scopes` у строки канала может быть чем угодно из прошлого:
    // читается оно на каждом показе списка каналов.
    expect(hasCaptionsScope([])).toBe(false);
    expect(hasCaptionsScope(null)).toBe(false);
    expect(hasCaptionsScope(undefined)).toBe(false);
  });
});
