import express = require('express');
import request = require('supertest');
import { qaStandVoiceJson } from './qa-stand-voice-json';
describe('scoped voice body limits', () => {
  function app() {
    const a = express();
    a.use(qaStandVoiceJson());
    a.use(express.json());
    a.post('/qa/sites/test/stands/voice', (req, res) =>
      res.json({ size: req.body.audio.length }),
    );
    a.post('/other', (req, res) => res.json(req.body));
    return a;
  }
  it('accepts voice body above default limit only on scoped endpoint', async () => {
    await request(app())
      .post('/qa/sites/test/stands/voice')
      .send({ audio: 'a'.repeat(150000) })
      .expect(200);
    await request(app())
      .post('/other')
      .send({ audio: 'a'.repeat(150000) })
      .expect(413);
  });
  it('rejects oversized and malformed bodies without echo', async () => {
    const r = await request(app())
      .post('/qa/sites/test/stands/voice')
      .set('Content-Type', 'application/json')
      .send('{secret')
      .expect(400);
    expect(JSON.stringify(r.body)).not.toContain('secret');
    await request(app())
      .post('/qa/sites/test/stands/voice')
      .send({ audio: 'a'.repeat(1600000) })
      .expect(413);
  });
});
