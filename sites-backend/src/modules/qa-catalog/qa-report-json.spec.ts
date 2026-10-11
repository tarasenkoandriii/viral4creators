import express = require('express');
import { json } from 'express';
import * as request from 'supertest';
import { qaReportImportJson } from './qa-report-json';
const path = '/qa/sites/site/runs/run/reports';
const app = () => {
  const a = express();
  a.use(qaReportImportJson());
  a.use(json());
  a.post(path, (req, res) => res.json({ length: req.body.data.length }));
  a.post('/other', (req, res) => res.json(req.body));
  return a;
};
describe('QA report scoped JSON transport', () => {
  it('accepts a report above default 100KiB only on report imports', async () => {
    await request(app())
      .post(path)
      .send({ data: 'x'.repeat(150 * 1024) })
      .expect(200, { length: 150 * 1024 });
    await request(app())
      .post('/other')
      .send({ data: 'x'.repeat(150 * 1024) })
      .expect(413);
  });
  it('caps the envelope and returns a safe error', async () => {
    const r = await request(app())
      .post(path)
      .send({ data: 'x'.repeat(521 * 1024) })
      .expect(413);
    expect(r.body.error.code).toBe('QA_REPORT_TOO_LARGE');
    expect(JSON.stringify(r.body)).not.toContain('xxxxx');
  });
  it('rejects malformed JSON without exposing input', async () => {
    const r = await request(app())
      .post(path)
      .set('Content-Type', 'application/json')
      .send('{ private')
      .expect(400);
    expect(r.body.error.code).toBe('QA_REPORT_INVALID');
    expect(JSON.stringify(r.body)).not.toContain('private');
  });
});
