import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { siteQaReportText, type SiteQaReport } from './qa-site-report';
export interface ReportImage {
  findingId: string;
  artifactId: string;
  bytes: Uint8Array;
}
export async function renderSiteQaPdf(
  report: SiteQaReport,
  fontBytes: Uint8Array,
  images: ReportImage[] = []
) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: false });
  let page = pdf.addPage([595.28, 841.89]);
  let y = 795;
  const line = (s: string, size = 10) => {
    if (y < 48) {
      page = pdf.addPage([595.28, 841.89]);
      y = 795;
    }
    page.drawText(s, { x: 42, y, size, font, color: rgb(0.1, 0.15, 0.22) });
    y -= size + 5;
  };
  const content = siteQaReportText(report)
    .split('PNG и адреса страниц/доказательств не включены.')
    .join(
      images.length
        ? 'Приватные PNG приложены в конце PDF; адреса страниц/доказательств не включены.'
        : 'PNG и адреса страниц/доказательств не включены.'
    );
  for (const raw of content.split('\n')) {
    const heading = raw.startsWith('#') || raw === 'Сводный отчёт QA';
    const size = heading ? 13 : 10;
    const clean = raw
      .replace(/^#+\s*/, '')
      .replace(/\\([\\`*_{}[\]<>|#!])/g, '$1')
      .replace(/[\r\t]/g, ' ');
    let row = '';
    for (const word of clean.split(' ')) {
      if (
        font.widthOfTextAtSize(row + (row ? ' ' : '') + word, size) > 510 &&
        row
      ) {
        line(row, size);
        row = '';
      }
      // Long IDs and hashes must wrap too.
      for (const char of (row ? ' ' : '') + word) {
        if (font.widthOfTextAtSize(row + char, size) > 510 && row) {
          line(row, size);
          row = '';
        }
        row += char;
      }
    }
    line(row, size);
  }
  for (const image of images) {
    page = pdf.addPage([595.28, 841.89]);
    y = 795;
    line(`PNG: ${image.artifactId}`);
    line(`Замечание: ${image.findingId}`);
    const png = await pdf.embedPng(image.bytes);
    const scale = Math.min(510 / png.width, 650 / png.height, 1);
    page.drawImage(png, {
      x: 42,
      y: Math.max(48, y - 20 - png.height * scale),
      width: png.width * scale,
      height: png.height * scale,
    });
  }
  if (!images.length)
    line('PNG не встроены; метаданные доказательств перечислены выше.');
  pdf.getPages().forEach((p, i) =>
    p.drawText(`${i + 1} / ${pdf.getPageCount()}`, {
      x: 500,
      y: 24,
      font,
      size: 9,
    })
  );
  return pdf.save();
}
export async function collectReportImages(
  report: SiteQaReport,
  getLink: (findingId: string, artifactId: string) => Promise<{ url: string }>
) {
  const artifacts = report.entries.flatMap((e) =>
    e.artifacts.map((a) => ({ findingId: e.finding.id, artifact: a }))
  );
  if (
    artifacts.length > 20 ||
    artifacts.reduce((n, a) => n + a.artifact.bytes, 0) > 20 * 1024 * 1024
  )
    throw new Error(
      'Для PDF разрешено до 20 PNG и 20 МБ. Скачайте отчёт без встроенных PNG.'
    );
  const images: ReportImage[] = [];
  for (const { findingId, artifact } of artifacts) {
    const { url } = await getLink(findingId, artifact.id);
    const response = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error('Приватный PNG недоступен.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== artifact.bytes || bytes.length > 2 * 1024 * 1024)
      throw new Error('Размер PNG изменился.');
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (b) => b.toString(16).padStart(2, '0')
    ).join('');
    if (hash !== artifact.sha256) throw new Error('SHA-256 PNG не совпал.');
    images.push({ findingId, artifactId: artifact.id, bytes });
  }
  return images;
}
