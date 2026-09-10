import axios from 'axios';
import { TiktokOAuthService } from './tiktok-oauth.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const configState = {
  tiktokClientKey: 'ck-1',
  tiktokClientSecret: 'cs-1',
  apiPublicUrl: 'https://api.example.com',
};
jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({ publishing: configState }),
}));

describe('TiktokOAuthService', () => {
  let service: TiktokOAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    configState.tiktokClientKey = 'ck-1';
    configState.tiktokClientSecret = 'cs-1';
    configState.apiPublicUrl = 'https://api.example.com';
    service = new TiktokOAuthService();
  });

  describe('configured', () => {
    it('true при полном наборе ключей', () => {
      expect(service.configured()).toBe(true);
    });

    it('false без client_key', () => {
      configState.tiktokClientKey = '';
      expect(service.configured()).toBe(false);
    });
  });

  describe('buildAuthUrl', () => {
    it('строит ссылку с scope video.publish и redirect_uri на платформенный callback', () => {
      const url = service.buildAuthUrl('signed-state');
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe(
        'https://www.tiktok.com/v2/auth/authorize/',
      );
      expect(parsed.searchParams.get('scope')).toBe('video.publish');
      expect(parsed.searchParams.get('redirect_uri')).toBe(
        'https://api.example.com/channels/oauth/TIKTOK/callback',
      );
      expect(parsed.searchParams.get('state')).toBe('signed-state');
    });
  });

  describe('exchangeCode', () => {
    it('превращает код в токены', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 86400,
          scope: 'video.publish',
        },
      });
      const tokens = await service.exchangeCode('code-1');
      expect(tokens.accessToken).toBe('at-1');
      expect(tokens.refreshToken).toBe('rt-1');
      expect(tokens.scopes).toEqual(['video.publish']);
    });
  });

  describe('refreshAccessToken', () => {
    it('обновляет access-токен', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'at-new', expires_in: 3600 },
      });
      const result = await service.refreshAccessToken('rt-1');
      expect(result.accessToken).toBe('at-new');
    });
  });

  describe('fetchChannelInfo', () => {
    it('возвращает открытый id/имя/аватар пользователя', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          data: {
            user: {
              open_id: 'oid-1',
              display_name: 'Мой TikTok',
              avatar_url: 'https://x/a.png',
            },
          },
        },
      });
      const info = await service.fetchChannelInfo('at-1');
      expect(info).toEqual({
        externalId: 'oid-1',
        title: 'Мой TikTok',
        avatarUrl: 'https://x/a.png',
      });
    });

    it('бросает, если TikTok не вернул пользователя', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: {} });
      await expect(service.fetchChannelInfo('at-1')).rejects.toThrow(
        /не вернул данные аккаунта/,
      );
    });
  });

  describe('revoke', () => {
    it('не обращается к сети и не бросает — у TikTok Login Kit нет revoke-эндпоинта', async () => {
      await expect(service.revoke('at-1')).resolves.toBeUndefined();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('работает и без аргумента (сигнатура зеркалит GoogleOAuthService)', async () => {
      await expect(service.revoke()).resolves.toBeUndefined();
    });
  });
});
