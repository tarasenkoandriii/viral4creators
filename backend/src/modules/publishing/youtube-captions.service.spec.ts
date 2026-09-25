import axios from 'axios';
import { YoutubeCaptionsService } from './youtube-captions.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * Загрузка субтитров (этап 137). Тело запроса собирается руками, и
 * ошибиться в нём легче всего: площадка отвечает 400 без подробностей,
 * а проверить формат в песочнице нечем.
 */
const input = {
  videoId: 'yt-1',
  language: 'uk',
  name: 'Original',
  srt: '1\n00:00:01,000 --> 00:00:03,000\nПривіт\n',
};

const bodyOf = () => mockedAxios.post.mock.calls[0][1] as string;
const configOf = () =>
  mockedAxios.post.mock.calls[0][2] as {
    headers: Record<string, string>;
  };

describe('YoutubeCaptionsService.insert', () => {
  beforeEach(() => mockedAxios.post.mockReset());

  it('шлёт multipart из двух частей: snippet и сам файл', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { id: 'c1' } });

    const result = await new YoutubeCaptionsService().insert(input, 'at');

    expect(result).toEqual({ captionId: 'c1' });
    const body = bodyOf();
    // Граница объявлена в заголовке и ею же разделены части — без этого
    // площадка видит одну бесформенную строку.
    const boundary = configOf()
      .headers['Content-Type'].split('boundary=')[1]
      .trim();
    expect(body.split(`--${boundary}`).length).toBeGreaterThanOrEqual(3);
    expect(body).toContain('application/json');
    expect(body).toContain('"videoId":"yt-1"');
    expect(body).toContain('"language":"uk"');
    expect(body).toContain('Привіт');
    // Завершающая граница обязательна: без неё запрос считается обрезанным.
    expect(body.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });

  it('части разделены CRLF, как требует формат', async () => {
    // Голый \n в multipart принимают не все реализации, и это ровно тот
    // случай, когда «у меня работает» и «работает у площадки» расходятся.
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { id: 'c1' } });
    await new YoutubeCaptionsService().insert(input, 'at');
    expect(bodyOf()).toContain('\r\n');
  });

  it('дорожка не черновик — иначе зритель её не увидит', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { id: 'c1' } });
    await new YoutubeCaptionsService().insert(input, 'at');
    expect(bodyOf()).toContain('"isDraft":false');
  });

  it('отказ площадки — исключение с её же кодом и текстом', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 403,
      data: { error: { message: 'insufficient scope' } },
    });
    await expect(
      new YoutubeCaptionsService().insert(input, 'at'),
    ).rejects.toThrow(/403.*insufficient scope/);
  });

  it('успех без id дорожки — тоже ошибка, а не молчаливое «загрузили»', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: {} });
    await expect(
      new YoutubeCaptionsService().insert(input, 'at'),
    ).rejects.toThrow(/без id/);
  });

  it('длинное имя дорожки режется по потолку площадки', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { id: 'c1' } });
    await new YoutubeCaptionsService().insert(
      { ...input, name: 'и'.repeat(300) },
      'at',
    );
    const snippet = JSON.parse(
      bodyOf().split('\r\n\r\n')[1].split('\r\n')[0],
    ) as { snippet: { name: string } };
    expect(snippet.snippet.name.length).toBe(150);
  });
});
