import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { AssistantChatRequestDto } from './assistant-chat-request.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const run = (v: unknown) =>
  pipe.transform(v, {
    type: 'body',
    metatype: AssistantChatRequestDto,
    data: '',
  });
const ok = (v: unknown) => expect(run(v)).resolves.toBeDefined();
const bad = (v: unknown) =>
  expect(run(v)).rejects.toBeInstanceOf(BadRequestException);

const base = {
  locale: 'ru',
  page: 'how-it-works' as const,
  messages: [{ role: 'user', content: 'Привет' }],
};

describe('AssistantChatRequestDto under the real ValidationPipe (ТЗ §4.3)', () => {
  it('принимает минимальный валидный запрос', async () => {
    await ok(base);
  });

  it('принимает stepId 1..9 и triggeredBy', async () => {
    await ok({ ...base, stepId: 7, triggeredBy: 'proactive' });
  });

  it('отклоняет неизвестную локаль', async () => {
    await bad({ ...base, locale: 'fr' });
  });

  it('отклоняет stepId вне 1..9', async () => {
    await bad({ ...base, stepId: 0 });
    await bad({ ...base, stepId: 10 });
  });

  it('отклоняет пустой messages', async () => {
    await bad({ ...base, messages: [] });
  });

  it('отклоняет больше 10 реплик', async () => {
    const messages = Array.from({ length: 11 }, (_, i) => ({
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: `msg ${i}`,
    }));
    messages[messages.length - 1] = { role: 'user', content: 'последний' };
    await bad({ ...base, messages });
  });

  it('отклоняет, если последняя реплика не user', async () => {
    await bad({
      ...base,
      messages: [
        { role: 'user', content: 'вопрос' },
        { role: 'assistant', content: 'ответ' },
      ],
    });
  });

  it('отклоняет user-сообщение длиннее 600 символов', async () => {
    await bad({
      ...base,
      messages: [{ role: 'user', content: 'x'.repeat(601) }],
    });
  });

  it('принимает user-сообщение ровно 600 символов', async () => {
    await ok({
      ...base,
      messages: [{ role: 'user', content: 'x'.repeat(600) }],
    });
  });

  it('отклоняет, если суммарная длина превышает 6000 символов', async () => {
    await bad({
      ...base,
      messages: [
        { role: 'assistant', content: 'x'.repeat(2000) },
        { role: 'assistant', content: 'x'.repeat(2000) },
        { role: 'assistant', content: 'x'.repeat(2000) },
        { role: 'user', content: 'ещё вопрос' },
      ],
    });
  });

  it('отклоняет незнакомое поле (forbidNonWhitelisted)', async () => {
    await bad({ ...base, extra: 'nope' });
  });

  it('отклоняет неизвестную роль в сообщении', async () => {
    await bad({ ...base, messages: [{ role: 'system', content: 'x' }] });
  });
});
