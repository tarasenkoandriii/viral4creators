import axios from 'axios';
import {
  TiktokUploadService,
  tiktokPublishPrivacy,
} from './tiktok-upload.service';

jest.mock('axios');
const mocked = axios as jest.Mocked<typeof axios>;

const CREATOR = (over: Record<string, unknown> = {}) => ({
  status: 200,
  data: {
    data: {
      privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
      comment_disabled: true,
      duet_disabled: false,
      stitch_disabled: true,
      max_video_post_duration_sec: 600,
      ...over,
    },
    error: { code: 'ok' },
  },
});

describe('TiktokUploadService — порт creator_info из SilverFinance (01.10.2026)', () => {
  const prev = process.env.TIKTOK_PUBLISH_PRIVACY;
  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.TIKTOK_PUBLISH_PRIVACY;
  });
  afterAll(() => {
    process.env.TIKTOK_PUBLISH_PRIVACY = prev;
  });

  function arrange(creator = CREATOR()) {
    mocked.post.mockImplementation(async (url: string) =>
      url.includes('creator_info')
        ? creator
        : {
            status: 200,
            data: {
              data: { publish_id: 'p1', upload_url: 'https://up' },
              error: { code: 'ok' },
            },
          },
    );
    mocked.get.mockResolvedValue({ data: new Uint8Array([1, 2, 3]).buffer });
  }

  it('сначала creator_info, затем init с запретами аккаунта и SELF_ONLY', async () => {
    arrange();
    const out = await new TiktokUploadService().init(
      { title: 't', description: 'd', videoUrl: 'https://blob/v.mp4' },
      'at',
    );
    const urls = mocked.post.mock.calls.map((c) => c[0]);
    expect(urls[0]).toContain('/creator_info/query/');
    expect(urls[1]).toContain('/video/init/');
    const body = mocked.post.mock.calls[1][1] as {
      post_info: Record<string, unknown>;
      source_info: Record<string, unknown>;
    };
    expect(body.post_info).toMatchObject({
      privacy_level: 'SELF_ONLY',
      disable_comment: true,
      disable_duet: false,
      disable_stitch: true,
    });
    expect(body.source_info.video_size).toBe(3);
    expect(out.bytes.length).toBe(3);
  });

  it('видимость из переменной, недоступная аккаунту, — отказ до init и до скачивания', async () => {
    process.env.TIKTOK_PUBLISH_PRIVACY = 'PUBLIC_TO_EVERYONE';
    arrange(CREATOR({ privacy_level_options: ['SELF_ONLY'] }));
    await expect(
      new TiktokUploadService().init(
        { title: 't', description: '', videoUrl: 'https://blob/v.mp4' },
        'at',
      ),
    ).rejects.toThrow(/TIKTOK_PUBLISH_PRIVACY/);
    expect(mocked.get).not.toHaveBeenCalled();
    expect(mocked.post).toHaveBeenCalledTimes(1);
  });

  it('ошибка creator_info в теле 200 — терминальная', async () => {
    arrange({
      status: 200,
      data: { error: { code: 'scope_not_authorized', message: 'x' } },
    } as never);
    await expect(
      new TiktokUploadService().init(
        { title: 't', description: '', videoUrl: 'https://blob/v.mp4' },
        'at',
      ),
    ).rejects.toThrow(/scope_not_authorized/);
  });

  it('заливка берёт байты из init, не скачивая ролик снова', async () => {
    mocked.put.mockResolvedValue({ status: 200, data: {} });
    await new TiktokUploadService().uploadBytes(
      'https://up',
      'https://blob/v.mp4',
      Buffer.from([1, 2]),
    );
    expect(mocked.get).not.toHaveBeenCalled();
    expect(mocked.put.mock.calls[0][2]?.headers).toMatchObject({
      'Content-Range': 'bytes 0-1/2',
    });
  });

  it('tiktokPublishPrivacy: умолчание SELF_ONLY', () => {
    expect(tiktokPublishPrivacy({})).toBe('SELF_ONLY');
    expect(
      tiktokPublishPrivacy({
        TIKTOK_PUBLISH_PRIVACY: ' MUTUAL_FOLLOW_FRIENDS ',
      }),
    ).toBe('MUTUAL_FOLLOW_FRIENDS');
  });
});
