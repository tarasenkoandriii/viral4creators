"use client";

import { useRef, useState } from "react";
import { compileFfmpegDraft, ffmpegErrorText } from "../../lib/ffmpeg";
import type { FfmpegJobDetail } from "../../lib/types";

/** Advisory export only: a new render remains an explicit product operation. */
export function ReviewDraftPanel({ job }: { job: FfmpegJobDetail }) {
  const sources = job.inputs.filter(
    (file) =>
      file.sha256 &&
      file.mime?.startsWith("video/") &&
      file.streams.some((stream) => stream.type === "video"),
  );
  const outputs = job.outputs.filter(
    (file) => file.sha256 && file.mime === "video/mp4",
  );
  const [sourceName, setSourceName] = useState(sources[0]?.name ?? "");
  const [outputName, setOutputName] = useState(outputs[0]?.name ?? "");
  const source = sources.find((file) => file.name === sourceName);
  const output = outputs.find((file) => file.name === outputName);
  const [text, setText] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  if (!source || !output) return null;
  const sample = () =>
    JSON.stringify(
      {
        sourceInputKey: source.name,
        sourceSha256: source.sha256,
        outputSha256: output.sha256,
        recipe: {},
        suggestions: [],
        selectedParameters: [],
      },
      null,
      2,
    );
  const change = (value: string) => {
    revision.current++;
    setText(value);
    setResult(null);
    setError("");
    setBusy(false);
  };
  async function check() {
    const current = ++revision.current;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const document: unknown = JSON.parse(text || sample());
      const next = await compileFfmpegDraft(job.id, output!.name, document);
      if (revision.current === current) setResult(next);
    } catch (e) {
      if (revision.current === current)
        setError(
          e instanceof SyntaxError
            ? "Проверьте формат JSON."
            : ffmpegErrorText(e),
        );
    } finally {
      if (revision.current === current) setBusy(false);
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "ffmpeg-review-draft.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <details style={{ marginTop: 16 }}>
      <summary>Черновик manifest после проверки результата</summary>
      <p className="muted">
        Бесплатная проверка рекомендаций по SHA-256 исходника и результата. Без
        вызова ИИ, рендера и одобрения ролика. Новый рендер выполняется только
        из исходника.
      </p>
      <label>
        Исходник{" "}
        <select
          value={sourceName}
          onChange={(event) => {
            setSourceName(event.target.value);
            change("");
          }}
        >
          {sources.map((file) => (
            <option key={file.name} value={file.name}>
              {file.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Проверяемый результат{" "}
        <select
          value={outputName}
          onChange={(event) => {
            setOutputName(event.target.value);
            change("");
          }}
        >
          {outputs.map((file) => (
            <option key={file.name} value={file.name}>
              {file.name}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => change(sample())}>
        Подставить хеши выбранных файлов
      </button>
      <label style={{ display: "block" }}>
        Рецепт, рекомендации и явно выбранные параметры (JSON, до 32 КиБ)
        <textarea
          aria-label="Документ проверки manifest"
          rows={12}
          value={text}
          maxLength={32768}
          onChange={(event) => change(event.target.value)}
          style={{ width: "100%" }}
        />
      </label>
      <button type="button" disabled={busy} onClick={() => void check()}>
        {busy ? "Проверяем…" : "Проверить черновик"}
      </button>
      {error && <p role="alert">{error}</p>}
      {result !== null && (
        <>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(result, null, 2)}
          </pre>
          <button type="button" onClick={download}>
            Скачать черновик для проверки человеком
          </button>
        </>
      )}
    </details>
  );
}
