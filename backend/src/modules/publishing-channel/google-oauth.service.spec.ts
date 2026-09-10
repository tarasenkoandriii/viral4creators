import axios from 'axios';
import { GoogleOAuthService } from './google-oauth.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const configState = {
  googleClientId: 'client-1',
  googleClientSecret: 'secret-1',
  apiPublicUrl: 'https://api.example.com/',
};
jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({ publishing: configState }),
}));

describe('GoogleOAuthService', () => {
  let service: GoogleOAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    configState.googleClientId = 'client-1';
    configState.googleClientSecret = 'secret-1';
    configState.apiPublicUrl = 'https://api.example.com/';
    service = new GoogleOAuthService();
  });

  describe('configured', () => {
    it('true, когда все три поля заданы', () => {
      expect(service.configured()).toBe(true);
    });

    it('false, если чего-то не хватает', () => {
      configState.googleClientId = '';
      expect(service.configured()).toBe(false);
    });
  });

  describe('buildAuthUrl', () => {
    it('строит ссылку согласия с redirect_uri без задвоенного слэша и переданным state', () => {
      const url = service.buildAuthUrl('signed-state');
      expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
      const parsed = new URL(url);
      expect(parsed.searchParams.get('client_id')).toBe('client-1');
      expect(parsed.searchParams.get('redirect_uri')).toBe(
        'https://api.example.com/channels/oauth/YOUTUBE/callback',
      );
      expect(parsed.searchParams.get('state')).toBe('signed-state');
      expect(parsed.searchParams.get('access_type')).toBe('offline');
      expect(parsed.searchParams.get('prompt')).toBe('consent');
      expect(parsed.searchParams.get('scope')).toContain('youtube.upload');
    });
  });

  describe('exchangeCode', () => {
    it('превращает код в токены', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 3600,
          scope:
            'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
        },
      });
      const tokens = await service.exchangeCode('code-1');
      expect(tokens.accessToken).toBe('at-1');
      expect(tokens.refreshToken).toBe('rt-1');
      expect(tokens.scopes).toHaveLength(2);
      expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('refreshToken=null, если Google его не вернул (повторное согласие без prompt=consent)', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'at-1',
          expires_in: 3600,
          scope: 'youtube.upload',
        },
      });
      const tokens = await service.exchangeCode('code-1');
      expect(tokens.refreshToken).toBeNull();
    });
  });

  describe('refreshAccessToken', () => {
    it('обновляет access-токен по refresh-токену', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'at-new', expires_in: 1800 },
      });
      const result = await service.refreshAccessToken('rt-1');
      expect(result.accessToken).toBe('at-new');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/token',
        expect.stringContaining('grant_type=refresh_token'),
        expect.any(Object),
      );
    });
  });

  describe('fetchChannelInfo', () => {
    it('возвращает title/avatar первого канала', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: 'UC123',
              snippet: {
                title: 'Мой канал',
                thumbnails: { default: { url: 'https://x/avatar.png' } },
              },
            },
          ],
        },
      });
      const info = await service.fetchChannelInfo('at-1');
      expect(info).toEqual({
        externalId: 'UC123',
        title: 'Мой канал',
        avatarUrl: 'https://x/avatar.png',
      });
    });

    it('бросает понятную ошибку, если у аккаунта нет YouTube-канала', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { items: [] } });
      await expect(service.fetchChannelInfo('at-1')).rejects.toThrow(
        /нет ни одного YouTube-канала/,
      );
    });
  });

  describe('revoke', () => {
    it('best-effort: не бросает наружу, если Google ответил ошибкой', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('network down'));
      await expect(service.revoke('at-1')).resolves.toBeUndefined();
    });
  });
});
