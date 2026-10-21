/**
 * Метрики в формате Prometheus text 0.0.4 (ТЗ §12). Без зависимостей:
 * счётчики, гистограммы и gauge-функции, считываемые при скрейпе.
 * Метки — только из закрытых словарей (статусы, коды ошибок, этапы):
 * client_id допустим, URL/ключи/имена файлов — нет.
 */
type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  return (
    '{' +
    keys
      .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`)
      .join(',') +
    '}'
  );
}

interface Hist {
  buckets: number[];
  counts: Map<string, { b: number[]; sum: number; count: number }>;
}

export class Metrics {
  private readonly counters = new Map<
    string,
    { help: string; v: Map<string, number> }
  >();
  private readonly hists = new Map<string, { help: string; h: Hist }>();
  private readonly gauges = new Map<
    string,
    { help: string; fn: () => Array<[Labels, number]> }
  >();

  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    let c = this.counters.get(name);
    if (!c) {
      c = { help, v: new Map() };
      this.counters.set(name, c);
    }
    const k = labelKey(labels);
    c.v.set(k, (c.v.get(k) ?? 0) + by);
  }

  observe(
    name: string,
    help: string,
    value: number,
    labels: Labels = {},
    buckets = [1, 5, 15, 30, 60, 120, 300, 600, 900, 1200],
  ): void {
    let h = this.hists.get(name);
    if (!h) {
      h = { help, h: { buckets, counts: new Map() } };
      this.hists.set(name, h);
    }
    const k = labelKey(labels);
    let e = h.h.counts.get(k);
    if (!e) {
      e = { b: h.h.buckets.map(() => 0), sum: 0, count: 0 };
      h.h.counts.set(k, e);
    }
    h.h.buckets.forEach((le, i) => {
      if (value <= le) e!.b[i]++;
    });
    e.sum += value;
    e.count++;
  }

  gauge(name: string, help: string, fn: () => Array<[Labels, number]>): void {
    this.gauges.set(name, { help, fn });
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, c] of this.counters) {
      lines.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
      for (const [k, v] of c.v) lines.push(`${name}${k} ${v}`);
    }
    for (const [name, g] of this.gauges) {
      lines.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
      let rows: Array<[Labels, number]> = [];
      try {
        rows = g.fn();
      } catch {
        rows = [];
      }
      for (const [l, v] of rows) lines.push(`${name}${labelKey(l)} ${v}`);
    }
    for (const [name, { help, h }] of this.hists) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
      for (const [k, e] of h.counts) {
        const inner = k ? k.slice(1, -1) + ',' : '';
        h.buckets.forEach((le, i) =>
          lines.push(`${name}_bucket{${inner}le="${le}"} ${e.b[i]}`),
        );
        lines.push(`${name}_bucket{${inner}le="+Inf"} ${e.count}`);
        lines.push(`${name}_sum${k} ${e.sum}`, `${name}_count${k} ${e.count}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}
