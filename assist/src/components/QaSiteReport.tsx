import { useState } from 'react';
import { Button } from '../kit/ui';
import { useAssist } from '../lib/assist-context';
import { loadSiteQaReport, siteQaReportText } from '../lib/qa-site-report';
export function QaSiteReport({
  siteId,
  disabled,
}: {
  siteId: string;
  disabled: boolean;
}) {
  const { qaFindings: api } = useAssist();
  const [busy, setBusy] = useState(false),
    [include, setInclude] = useState(false),
    [message, setMessage] = useState('');
  async function download(pdf: boolean) {
    setBusy(true);
    setMessage('');
    try {
      const report = await loadSiteQaReport(api, siteId);
      let blob: Blob;
      if (pdf) {
        const { renderSiteQaPdf, collectReportImages } =
          await import('../lib/qa-site-report-pdf');
        const font = await fetch('/fonts/qa-report.ttf');
        if (!font.ok) throw new Error('Шрифт PDF недоступен.');
        const images = include
          ? await collectReportImages(report, (f, a) =>
              api.artifactLink(siteId, f, a)
            )
          : [];
        const bytes = await renderSiteQaPdf(
          report,
          new Uint8Array(await font.arrayBuffer()),
          images
        );
        blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
      } else
        blob = new Blob([siteQaReportText(report)], {
          type: 'text/markdown;charset=utf-8',
        });
      const url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = `qa-site-${siteId.replace(/[^a-zA-Z0-9_-]/g, '_')}.${pdf ? 'pdf' : 'md'}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        `Скачивание начато: ${report.entries.length} замечаний. Публичная ссылка не создавалась.`
      );
    } catch (e) {
      setMessage(
        `Отчёт не выгружен. ${e instanceof Error ? e.message : 'Повторите попытку.'}`
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-2" aria-label="Сводный отчёт QA">
      <h2 className="font-semibold">Сводный отчёт сайта</h2>
      <p>
        Весь доступный реестр, независимо от фильтра списка. При изменении
        ревизий выгрузка отменяется. До 200 замечаний; PDF создаётся локально,
        без публикации.
      </p>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={include}
          disabled={busy || disabled}
          onChange={(e) => setInclude(e.target.checked)}
        />
        Включить приватные PNG в локальный PDF (до 20 файлов / 20 МБ). Скачанный
        файл будет содержать доказательства; проверьте его перед передачей.
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || disabled}
          onClick={() => void download(false)}
        >
          Сводный отчёт (.md)
        </Button>
        <Button
          variant="outline"
          disabled={busy || disabled}
          onClick={() => void download(true)}
        >
          Сводный отчёт (.pdf)
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
