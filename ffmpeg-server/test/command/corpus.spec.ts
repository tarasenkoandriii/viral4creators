import { parseJob } from '../../src/command/parse';
import { parseFiltergraph } from '../../src/command/filtergraph';
import { tokenize } from '../../src/command/tokenize';
import {
  ALLOWED_FILTERS,
  EXPR_IDENTIFIERS,
  FILTER_SPECS,
  ALLOWED_AUDIO_CODECS,
  ALLOWED_VIDEO_CODECS,
  CLI_OPTIONS,
} from '../../src/command/allowlist';
import { loadCorpus } from '../fixtures/corpus';
import { PILOT_LIMITS } from '../fixtures/limits';

const corpus = loadCorpus();

describe('корпус команд платформы', () => {
  it('корпус не пуст и покрывает всех потребителей', () => {
    expect(new Set(corpus.map((e) => e.product)).size).toBeGreaterThanOrEqual(
      10,
    );
  });

  it.each(corpus.map((e) => [e.id, e] as const))(
    '%s проходит parseJob без правки строк',
    (_id, entry) => {
      const r = parseJob(entry.request, PILOT_LIMITS);
      expect(r).toMatchObject({ ok: true });
      if (!r.ok) return;
      const { plan } = r;
      expect(plan.steps).toHaveLength(entry.request.ffmpeg_commands.length);
      expect(plan.outputs.map((o) => o.name)).toEqual(
        entry.request.output_files,
      );
      for (const step of plan.steps) {
        const argv = step.argv;
        expect(argv.slice(0, 3)).toEqual(['-nostdin', '-hide_banner', '-y']);
        expect(argv).not.toContain('ffmpeg');
        // Ни одного плейсхолдера, URL или абсолютного пути после подстановки.
        for (const a of argv) {
          expect(a).not.toMatch(/\{\{|\}\}/);
          expect(a).not.toMatch(/https?:\/\//);
          expect(a.startsWith('/')).toBe(false);
        }
        // Каждому -i предшествуют protocol/format whitelist и threads.
        const inputIdx = argv.flatMap((a, i) => (a === '-i' ? [i] : []));
        for (const i of inputIdx) {
          const before = argv.slice(0, i);
          expect(before.lastIndexOf('-protocol_whitelist')).toBeGreaterThan(
            before.lastIndexOf('-i'),
          );
          expect(argv[i + 1]).toMatch(/^(inputs|outputs|work)\//);
        }
        const t = argv.indexOf('-filter_complex_threads');
        expect(Number(argv[t + 1])).toBeLessThanOrEqual(
          PILOT_LIMITS.maxThreads,
        );
      }
    },
  );

  it('allowlist построен из корпуса: каждый фильтр и опция корпуса разрешены, лишних нет', () => {
    const filters = new Set<string>();
    const options = new Set<string>();
    const vcodecs = new Set<string>();
    const acodecs = new Set<string>();
    // фильтр → опция (ключ или #позиция) → значения корпуса
    const opts = new Map<string, Map<string, Set<string>>>();
    const exprIds = new Set<string>();
    for (const e of corpus) {
      for (const cmd of e.request.ffmpeg_commands) {
        const tok = tokenize(cmd);
        if (!tok.ok) throw new Error(tok.message);
        const t = tok.tokens[0] === 'ffmpeg' ? tok.tokens.slice(1) : tok.tokens;
        t.forEach((x, i) => {
          if (!x.startsWith('-') || x === '-') return;
          const base = x.slice(1).split(':')[0];
          if (/^-?\d/.test(x.slice(1))) return; // значение (-1)
          options.add(base);
          if (x === '-c:v') vcodecs.add(t[i + 1]);
          if (x === '-c:a') acodecs.add(t[i + 1]);
          if (x === '-filter_complex' || x === '-vf') {
            const g = parseFiltergraph(t[i + 1]);
            if (!g.ok) throw new Error(g.message);
            for (const f of g.filters) {
              filters.add(f.name);
              const m = opts.get(f.name) ?? new Map<string, Set<string>>();
              opts.set(f.name, m);
              for (const o of f.options) {
                const k = o.key ?? `#${o.position}`;
                const vals = m.get(k) ?? new Set<string>();
                m.set(k, vals);
                vals.add(o.value);
                const spec = FILTER_SPECS[f.name];
                const kind =
                  o.key !== null
                    ? spec?.keys[o.key]
                    : spec?.positional[o.position!];
                if (kind?.kind === 'expr') {
                  for (const id of o.value.match(/[A-Za-z_][A-Za-z0-9_]*/g) ??
                    []) {
                    exprIds.add(id);
                  }
                }
              }
            }
          }
        });
      }
    }
    expect([...filters].sort()).toEqual([...ALLOWED_FILTERS].sort());
    // FF-SEC-01: ключи и позиционные значения — ровно корпусные, по фильтру.
    for (const [name, spec] of Object.entries(FILTER_SPECS)) {
      const used = [...(opts.get(name)?.keys() ?? [])].sort();
      const allowed = [
        ...Object.keys(spec.keys),
        ...spec.positional.map((_, i) => `#${i}`),
      ].sort();
      expect({ name, keys: used }).toEqual({ name, keys: allowed });
      for (const [k, kind] of Object.entries(spec.keys)) {
        if (kind.kind !== 'enum') continue;
        expect({
          name,
          k,
          values: [...opts.get(name)!.get(k)!].sort(),
        }).toEqual({
          name,
          k,
          values: [...kind.values].sort(),
        });
      }
    }
    expect([...exprIds].sort()).toEqual([...EXPR_IDENTIFIERS].sort());
    const corpusOptions = Object.entries(CLI_OPTIONS)
      .filter(([, d]) => d.corpus)
      .map(([k]) => k)
      .concat('i');
    expect([...options].sort()).toEqual(corpusOptions.sort());
    expect([...vcodecs].sort()).toEqual([...ALLOWED_VIDEO_CODECS].sort());
    expect([...acodecs].sort()).toEqual([...ALLOWED_AUDIO_CODECS].sort());
  });
});
