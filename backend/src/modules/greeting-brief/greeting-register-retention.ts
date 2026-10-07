/**
 * Срок хранения памяти ответов классификатора регистра
 * (`greeting_register_answers`, заход 8 C14; аудит захода 8).
 *
 * 180 дней: этого хватает, чтобы правки одного брифа и следующие
 * поздравления на тот же повод не платили за повторный вызов, а строки
 * не копились годами. Отдельный лёгкий модуль, а не константа в сервисе
 * классификатора: уборку зовёт суточный крон `cleanup-sessions`
 * (`CronJobsService`), и тянуть ради неё клиент Gemini незачем.
 *
 * Классификатор сам не верит записи старше срока (`recall`), так что
 * отставший крон на ответ не влияет — только на размер таблицы.
 */

import { PrismaService } from '../../prisma/prisma.service';

export const GREETING_REGISTER_ANSWER_RETENTION_DAYS = 180;
export const GREETING_REGISTER_ANSWER_RETENTION_MS =
  GREETING_REGISTER_ANSWER_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Граница: записи, созданные раньше неё, уже не действуют. */
export function greetingRegisterAnswerCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - GREETING_REGISTER_ANSWER_RETENTION_MS);
}

/** Удалить просроченные записи; возвращает число удалённых. */
export async function pruneGreetingRegisterAnswers(
  prisma: Pick<PrismaService, 'greetingRegisterAnswer'>,
  now: Date = new Date(),
): Promise<number> {
  const r = await prisma.greetingRegisterAnswer.deleteMany({
    where: { createdAt: { lt: greetingRegisterAnswerCutoff(now) } },
  });
  return r.count;
}
