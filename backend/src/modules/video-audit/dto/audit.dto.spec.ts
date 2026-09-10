import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { ApplyFixRequestDto, RunAuditRequestDto } from './audit.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (m: any, v: unknown) =>
  pipe.transform(v, { type: 'body', metatype: m, data: '' });
const ok = (m: unknown, v: unknown) => expect(run(m, v)).resolves.toBeDefined();
const bad = (m: unknown, v: unknown) =>
  expect(run(m, v)).rejects.toBeInstanceOf(BadRequestException);

describe('audit DTOs', () => {
  it('run: empty body or an issue of 3–1000 chars', async () => {
    await ok(RunAuditRequestDto, {});
    await ok(RunAuditRequestDto, { issue: 'третья рука' });
    await bad(RunAuditRequestDto, { issue: 'x' });
    await bad(RunAuditRequestDto, { issue: 'x'.repeat(1001) });
    await bad(RunAuditRequestDto, { auto: true });
  });
  it('apply: auditId required, optional text 10–6000', async () => {
    await ok(ApplyFixRequestDto, { auditId: 'a' });
    await ok(ApplyFixRequestDto, { auditId: 'a', text: 'ten chars.' });
    await bad(ApplyFixRequestDto, {});
    await bad(ApplyFixRequestDto, { auditId: 'a', text: 'short' });
    await bad(ApplyFixRequestDto, { auditId: 'a', approve: true });
  });
});
