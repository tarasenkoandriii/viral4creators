/**
 * Заводит первую запись корпуса опыта (§6.6) — идемпотентно.
 *
 * ## Обычно запускать НЕ НУЖНО
 *
 * Запись заводит миграция `20261215090000_wizard_first_experience`,
 * то есть она появляется сама при обычном `prisma migrate deploy`.
 * Скрипт остался запасным путём ровно для двух случаев: база, где эта
 * миграция уже отмечена применённой, а строку удалили руками; и
 * восстановление из дампа, снятого до миграции.
 *
 * `npx ts-node --transpile-only scripts/seed-wizard-experience.ts`
 *
 * Запись создаётся ЧЕРНОВИКОМ: причину подтверждает владелец кнопкой
 * «Опубликовать» в админке (§15 п.1). Скрипт ничего не публикует —
 * публикация человеком и есть модерация §6.5.
 */

import { PrismaClient } from '@prisma/client';
import { FIRST_EXPERIENCE } from '../src/modules/wizard-guide/first-experience';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.wizardExperience.findFirst({
      where: {
        scenario: FIRST_EXPERIENCE.scenario,
        stepId: FIRST_EXPERIENCE.stepId,
        texts: { some: { symptom: FIRST_EXPERIENCE.text.symptom } },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      // eslint-disable-next-line no-console
      console.log(
        `запись уже есть: ${existing.id} (${existing.status}) — ничего не меняю`,
      );
      return;
    }
    const created = await prisma.wizardExperience.create({
      data: {
        scenario: FIRST_EXPERIENCE.scenario,
        stepId: FIRST_EXPERIENCE.stepId,
        status: 'DRAFT',
        texts: {
          create: {
            locale: FIRST_EXPERIENCE.text.locale,
            symptom: FIRST_EXPERIENCE.text.symptom,
            cause: FIRST_EXPERIENCE.text.cause,
            advice: FIRST_EXPERIENCE.text.advice,
            source: 'ADMIN',
            reviewed: true,
          },
        },
      },
      select: { id: true },
    });
    // eslint-disable-next-line no-console
    console.log(
      `черновик ${created.id} заведён — опубликуйте его в админке, ` +
        'подтвердив или поправив причину (§15 п.1)',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
