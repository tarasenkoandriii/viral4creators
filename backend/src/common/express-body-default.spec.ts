import express = require('express');
import * as request from 'supertest';
import { defaultEmptyBody } from './express-body-default';

/**
 * Заход 12: `req.body` после обновления на Express 5 ведёт себя как в
 * Express 4 — `{}` без тела, разобранное тело — когда парсер подошёл.
 */
function app() {
  const a = express();
  a.use(defaultEmptyBody);
  // Как в sites-backend: свой парсер пути — раньше общего JSON-парсера.
  a.use('/raw', express.text({ type: () => true, limit: '4kb' }));
  a.use(express.json());
  a.all('/{*splat}', (req, res) => {
    res.json({ type: typeof req.body, body: req.body ?? null });
  });
  return a;
}

describe('defaultEmptyBody (Express 5, заход 12)', () => {
  it('GET без тела — {} (в Express 5 без слоя было бы undefined)', async () => {
    const r = await request(app()).get('/x');
    expect(r.body).toEqual({ type: 'object', body: {} });
  });

  it('POST без тела и без Content-Type — {}', async () => {
    const r = await request(app()).post('/x');
    expect(r.body).toEqual({ type: 'object', body: {} });
  });

  it('text/plain на JSON-маршрут — {}, как в Express 4', async () => {
    const r = await request(app())
      .post('/x')
      .set('content-type', 'text/plain')
      .send('hello');
    expect(r.body).toEqual({ type: 'object', body: {} });
  });

  it('JSON разбирается и заменяет {}', async () => {
    const r = await request(app()).post('/x').send({ a: 1 });
    expect(r.body).toEqual({ type: 'object', body: { a: 1 } });
  });

  it('свой text-парсер пути: строка, общий JSON-парсер её не трогает', async () => {
    const r = await request(app())
      .post('/raw')
      .set('content-type', 'application/json')
      .send('{"b":2}');
    expect(r.body).toEqual({ type: 'string', body: '{"b":2}' });
  });

  it('уже выставленное тело не трогает и всегда зовёт next', () => {
    const next = jest.fn();
    const req = { body: 'x' } as unknown as express.Request;
    defaultEmptyBody(req, {} as express.Response, next);
    expect(req.body).toBe('x');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('имя слоя не совпадает с именами парсеров, которые Nest пропускает', () => {
    expect(['jsonParser', 'urlencodedParser']).not.toContain(
      defaultEmptyBody.name,
    );
  });
});
