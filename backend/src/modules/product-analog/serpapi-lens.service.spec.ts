import axios from 'axios';
import { SerpApiLensService, mapVisualMatches } from './serpapi-lens.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * Shaped like a real SerpApi google_lens `visual_matches` payload — the
 * two price shapes SilverFinance's mapper handles (`price.extracted_value`
 * on current responses, bare `extracted_price` on older ones), rows with
 * no price, no link, no thumbnail.
 */
const FIXTURE = [
  {
    position: 1,
    title: 'Nike Air Zoom Pegasus 40',
    link: 'https://shop.example/pegasus',
    source: 'shop.example',
    price: { value: '₴4 999', extracted_value: 4999, currency: '₴' },
    thumbnail: 'https://serpapi.example/t1.jpg',
    image: 'https://serpapi.example/i1.jpg',
  },
  {
    position: 2,
    title: '  Кроссовки беговые  ',
    link: 'https://other.example/run',
    extracted_price: 120.5, // older payload shape
    price: '$120.50',
    thumbnail: null,
    image: 'https://serpapi.example/i2.jpg',
  },
  {
    position: 3,
    title: '',
    link: 'https://noprice.example/x',
    source: 'noprice.example',
  },
  {
    position: 4,
    title: 'No link — must be dropped',
    thumbnail: 'https://serpapi.example/t4.jpg',
  },
];

describe('mapVisualMatches (ported from SilverFinance lens-search.ts)', () => {
  it('maps both price shapes, keeps SerpApi position, drops rows without a link', () => {
    const m = mapVisualMatches(FIXTURE);
    expect(m).toHaveLength(3);
    expect(m[0]).toEqual({
      position: 1,
      title: 'Nike Air Zoom Pegasus 40',
      url: 'https://shop.example/pegasus',
      source: 'shop.example',
      priceValue: '₴4 999',
      priceNumber: 4999,
      currency: '₴',
      image: 'https://serpapi.example/i1.jpg',
      thumbnail: 'https://serpapi.example/t1.jpg',
    });
    // older shape: bare extracted_price + string price
    expect(m[1].priceNumber).toBe(120.5);
    expect(m[1].priceValue).toBe('$120.50');
    expect(m[1].currency).toBeNull();
    expect(m[1].title).toBe('Кроссовки беговые'); // trimmed
    // no price at all
    expect(m[2].priceNumber).toBeNull();
    expect(m[2].priceValue).toBeNull();
    expect(m[2].title).toBe('—'); // empty title placeholder, as in SilverFinance
  });

  it('falls back to index+1 when position is missing and respects limit', () => {
    const rows = [
      { title: 'a', link: 'https://a' },
      { title: 'b', link: 'https://b' },
      { title: 'c', link: 'https://c' },
    ];
    expect(mapVisualMatches(rows).map((r) => r.position)).toEqual([1, 2, 3]);
    expect(mapVisualMatches(rows, 2)).toHaveLength(2);
  });

  it('tolerates garbage input', () => {
    expect(mapVisualMatches(undefined)).toEqual([]);
    expect(mapVisualMatches('nope')).toEqual([]);
    expect(mapVisualMatches([null, 42, {}])).toEqual([]);
  });
});

describe('SerpApiLensService.visualMatches', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    process.env.GEMINI_API_KEY = 'x';
  });

  const withKey = () => {
    process.env.SERPAPI_API_KEY = 'k';
    return new SerpApiLensService();
  };

  it('without a key: reason, not billed, no HTTP call', async () => {
    delete process.env.SERPAPI_API_KEY;
    const r = await new SerpApiLensService().visualMatches('https://img');
    expect(r).toEqual({
      matches: [],
      reason: 'SERPAPI_API_KEY not set',
      billed: false,
    });
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('rejects a non-public URL before calling', async () => {
    const r = await withKey().visualMatches('data:image/png;base64,AAA');
    expect(r.reason).toMatch(/public URL/);
    expect(r.billed).toBe(false);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('sends the google_lens params with hl/country from the project country', async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: { visual_matches: FIXTURE },
    });
    const r = await withKey().visualMatches('https://blob/photo.jpg', {
      countryCode: 'PL',
      language: 'pl',
    });
    const [url, cfg] = mockedAxios.get.mock.calls[0];
    expect(url).toBe('https://serpapi.com/search.json');
    expect(cfg?.params).toEqual({
      engine: 'google_lens',
      type: 'visual_matches',
      url: 'https://blob/photo.jpg',
      api_key: 'k',
      hl: 'pl',
      country: 'pl',
    });
    expect(r.billed).toBe(true);
    expect(r.matches).toHaveLength(3);
    expect(r.reason).toBeUndefined();
  });

  it('HTTP error → reason from body, NOT billed', async () => {
    mockedAxios.get.mockResolvedValue({
      status: 401,
      data: { error: 'Invalid API key. Your API key should be here: ...' },
    });
    const r = await withKey().visualMatches('https://blob/p.jpg');
    expect(r.matches).toEqual([]);
    expect(r.reason).toMatch(/Invalid API key/);
    expect(r.billed).toBe(false);
  });

  it('200 with an `error` field (Google found nothing) → empty but BILLED', async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: { error: "Google hasn't returned any results for this query." },
    });
    const r = await withKey().visualMatches('https://blob/p.jpg');
    expect(r.matches).toEqual([]);
    expect(r.billed).toBe(true);
  });

  it('network failure → reason, not billed, never throws', async () => {
    mockedAxios.get.mockRejectedValue(new Error('ETIMEDOUT'));
    const r = await withKey().visualMatches('https://blob/p.jpg');
    expect(r).toEqual({ matches: [], reason: 'ETIMEDOUT', billed: false });
  });
});
