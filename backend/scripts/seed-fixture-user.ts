/**
 * Ops-скрипт: заводит/обновляет фикстурного пользователя для
 * автоматического исполнителя сценариев обучающих видео (§3.3 ТЗ
 * doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 97).
 *
 * ## Зачем
 *
 * Сценарии (backend/src/modules/tutorial-scenario/) содержат шаги
 * `goto` на экраны мастера, которые требуют реального авторизованного
 * пользователя С ДАННЫМИ — иначе, например, экран с товаром или
 * готовым роликом просто нечем заполнить. §3.3 ТЗ прямо требует
 * «постоянного тестового пользователя с фикстурными данными» и говорит,
 * что эти данные поддерживаются отдельным скриптом вручную, а не
 * автоматически при каждом прогоне — прогон исполнителя ничего здесь не
 * меняет и не создаёт, только читает уже заведённое.
 *
 * ## Почему НЕ часть деплоя/миграций
 *
 * Это данные одной конкретной вымышленной учётной записи, а не схема:
 * прогонять их при каждом деплое незачем, а порядок (пользователь →
 * манифест → персонаж → проект → товар → сессия) специфичен ровно для
 * этой фикстуры. Запускать вручную:
 *   cd backend && DATABASE_URL=... FIXTURE_TELEGRAM_ID=... \
 *     npx ts-node --transpile-only scripts/seed-fixture-user.ts
 * (те же DATABASE_URL/FIXTURE_TELEGRAM_ID, что у бэкенд-деплоя — см.
 * .env.example).
 *
 * ## Идемпотентность
 *
 * Все ID фиксированы строками (не `cuid()` по умолчанию) — повторный
 * запуск обновляет те же строки, а не плодит дубликаты. Использует
 * `upsert` по `id`, поэтому безопасно перезапускать в любой момент,
 * например после ручной правки одного из полей в консоли Supabase.
 *
 * ## Осознанное упрощение: generatedVideo без настоящего файла
 *
 * Фикстурная сессия помечена завершённой (`generationStatus: 'complete'`,
 * `data.generatedVideo.status: 'complete'`) с `pathname`, указывающим на
 * несуществующий объект в Vercel Blob — исполнитель сценариев (§5 ТЗ,
 * будущий этап) взаимодействует с DOM (goto/fill/click/waitFor/
 * assertVisible/assertText), а не скачивает и не проигрывает сам файл
 * видео, так что реальные байты ролика ему не нужны. Экран результата
 * рендерится корректно (статус «готово», превью-плеер), но сам `<video>`
 * не воспроизведётся — не проблема для регрессионного прогона, который
 * проверяет структуру экрана, а не картинку в кадре. Если это когда-то
 * станет нужно (например, для скриншотов §4 ТЗ), сюда нужно будет
 * реально загрузить плейсхолдер-файл в Blob перед записью `pathname`.
 */

import { PrismaClient, ProjectType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { currencyForCountry } from '../src/common/data/countries';
import { GenerationStatus } from '../src/common/types/generation.types';
import { SessionStatus } from '../src/common/types/session.types';

const IDS = {
  manifest: 'fixture-tutorial-manifest',
  character: 'fixture-tutorial-character',
  project: 'fixture-tutorial-project',
  item: 'fixture-tutorial-item',
  session: 'fixture-tutorial-session',
  generatedVideo: 'fixture-tutorial-generated-video',
};

async function main(): Promise<void> {
  const telegramId = process.env.FIXTURE_TELEGRAM_ID?.trim();
  if (!telegramId) {
    throw new Error(
      'FIXTURE_TELEGRAM_ID не задан — та же переменная, что использует ' +
        'common/fixture-token.ts, см. .env.example',
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL не задан');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg(databaseUrl) });
  try {
    const user = await prisma.user.upsert({
      where: { telegramId },
      update: {},
      create: {
        telegramId,
        firstName: 'Fixture Runner',
        isOperator: false,
      },
    });
    console.log(`Пользователь: ${user.id} (telegramId=${telegramId})`);

    const manifest = await prisma.brandManifest.upsert({
      where: { id: IDS.manifest },
      update: { userId: user.id },
      create: {
        id: IDS.manifest,
        userId: user.id,
        title: 'Fixture Brand',
        styleNotes:
          'Фикстурный манифест бренда для автоматического исполнителя сценариев обучающих видео (этап 97).',
        voiceNotes: 'Нейтральный, дружелюбный тон.',
      },
    });
    console.log(`Манифест бренда: ${manifest.id}`);

    const character = await prisma.brandCharacter.upsert({
      where: { id: IDS.character },
      update: { brandManifestId: manifest.id },
      create: {
        id: IDS.character,
        brandManifestId: manifest.id,
        label: 'Fixture Model',
        description:
          'Персонаж-заглушка без фото — сценарии проверяют, что экран выбора персонажа открывается и показывает карточку, не саму картинку.',
      },
    });
    console.log(`Персонаж бренда: ${character.id}`);

    const project = await prisma.project.upsert({
      where: { id: IDS.project },
      update: { userId: user.id, brandManifestId: manifest.id },
      create: {
        id: IDS.project,
        userId: user.id,
        type: ProjectType.SINGLE,
        title: 'Fixture Project',
        countryCode: 'UA',
        currency: currencyForCountry('UA') ?? 'UAH',
        brandManifestId: manifest.id,
      },
    });
    console.log(`Проект: ${project.id}`);

    const item = await prisma.productItem.upsert({
      where: { id: IDS.item },
      update: { projectId: project.id },
      create: {
        id: IDS.item,
        projectId: project.id,
        title: 'Fixture Product',
        description:
          'Товар-заглушка для регрессионных сценариев обучающих видео — без фото.',
        category: 'demo',
      },
    });
    console.log(`Товар: ${item.id}`);

    // См. доккомментарий файла: реального файла в Blob по этому
    // pathname нет и не будет создано этим скриптом.
    const generatedVideo = {
      generatedVideoId: IDS.generatedVideo,
      pathname: `sessions/${IDS.session}/generated.mp4`,
      fileName: 'generated.mp4',
      mimeType: 'video/mp4',
      status: GenerationStatus.COMPLETE,
      // Строкой (не `Date`): `data` — Json-колонка, `Prisma.InputJsonValue`
      // не принимает `Date` напрямую (в отличие от настоящих DateTime-
      // колонок вроде `lastActivityAt`), а `JSON.stringify` всё равно
      // превратил бы `Date` в ту же ISO-строку.
      initiatedAt: new Date().toISOString(),
      provider: 'veo' as const,
    };

    const sessionData = {
      locale: 'ru',
      productInformation: {
        title: item.title,
        description: item.description,
      },
      generatedVideo,
    };

    await prisma.session.upsert({
      where: { id: IDS.session },
      update: {
        userId: user.id,
        projectId: project.id,
        productItemId: item.id,
        status: SessionStatus.VIDEO_COMPLETE,
        generationStatus: GenerationStatus.COMPLETE,
        data: sessionData,
      },
      create: {
        id: IDS.session,
        userId: user.id,
        projectId: project.id,
        productItemId: item.id,
        status: SessionStatus.VIDEO_COMPLETE,
        generationStatus: GenerationStatus.COMPLETE,
        data: sessionData,
      },
    });
    console.log(`Сессия с готовым роликом: ${IDS.session}`);

    console.log('Готово: фикстурные данные заведены/обновлены.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
