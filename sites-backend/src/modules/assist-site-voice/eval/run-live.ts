import { PrismaService } from '../../../prisma/prisma.service';
import {
  SonioxObservability,
  sonioxContext,
} from '../../soniox-observability/soniox-observability.service';
/**
 * Живой прогон приёмки Э5 п.3 — WER распознавания украинской речи на 30
 * записях (`npm run eval:voice`). Нужны: записи дикторов в
 * ASSIST_VOICE_EVAL_DIR (`uk-01.webm` … `uk-30.webm`, или .wav/.m4a/.ogg;
 * эталон — voice-eval-set.ts или `<id>.txt` рядом) и SONIOX_API_KEY. Тот же
 * клиент, что у виджета (SiteSonioxStt): каждая запись после распознавания
 * удаляется у провайдера. Деньги — ≈ 30 × 5 с × $0.10/ч ≈ $0.005.
 *
 * Выход: построчно id, слов, правок, WER, распознанный текст (это голоса
 * дикторов, а не посетителей — печатать можно); итог и код возврата 1, если
 * WER > VOICE_WER_THRESHOLD или записей меньше 30.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { SiteSonioxStt } from '../public/soniox-stt.client';
import { VOICE_EVAL_SET_UK } from './voice-eval-set';
import {
  VOICE_EVAL_SIZE,
  VOICE_WER_THRESHOLD,
  corpusWer,
  type WerItem,
} from './wer';

const MIME: Record<string, string> = {
  wav: 'audio/wav',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
};

async function main(): Promise<void> {
  const dir = process.env.ASSIST_VOICE_EVAL_DIR;
  if (!dir || !existsSync(dir)) {
    console.error(
      'ASSIST_VOICE_EVAL_DIR не задана или папки нет — записи дикторов (В-31)',
    );
    process.exit(2);
  }
  const db = process.env.SITES_DATABASE_URL ? new PrismaService() : undefined;
  const telemetry = db ? new SonioxObservability(db) : undefined;
  sonioxContext.enterWith({
    source: 'qa/site-voice-wer',
    actorRole: 'qa',
    actorId: null,
    accountId: null,
    siteId: null,
  });
  const stt = new SiteSonioxStt(telemetry);
  if (!stt.configured()) {
    console.error('SONIOX_API_KEY не задан');
    process.exit(2);
  }
  const files = readdirSync(dir);
  const items: WerItem[] = [];
  for (const p of VOICE_EVAL_SET_UK) {
    const file = files.find(
      (f) => f.startsWith(`${p.id}.`) && MIME[f.split('.').pop() ?? ''],
    );
    if (!file) continue;
    const ext = file.split('.').pop() as string;
    const txt = join(dir, `${p.id}.txt`);
    const reference = existsSync(txt)
      ? readFileSync(txt, 'utf8').trim()
      : p.text;
    const r = await stt.transcribe({
      audio: readFileSync(join(dir, file)),
      mimeType: MIME[ext],
      languageHints: ['uk'],
    });
    items.push({ id: p.id, reference, hypothesis: r.text });
    console.log(`${p.id}\t${r.text ?? `— (${r.reason})`}`);
  }
  const rep = corpusWer(items);
  for (const it of rep.items) {
    console.log(
      `${it.id}\tслов ${it.words}\tправок ${it.edits}\tWER ${(it.wer * 100).toFixed(1)}%`,
    );
  }
  console.log(
    `ИТОГО: записей ${items.length}/${VOICE_EVAL_SIZE}, слов ${rep.words}, правок ${rep.edits}, WER ${(rep.wer * 100).toFixed(1)}% (порог ${VOICE_WER_THRESHOLD * 100}%)`,
  );
  await db?.$disconnect();
  process.exit(
    items.length >= VOICE_EVAL_SIZE && rep.wer <= VOICE_WER_THRESHOLD ? 0 : 1,
  );
}

void main();
