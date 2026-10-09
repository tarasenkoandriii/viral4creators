/**
 * Vercel serverless entrypoint (finding #1 in doc/VERCEL-READINESS-AUDIT.md).
 *
 * Vercel auto-detects a `server.{js,cjs,mjs,ts,cts,mts}` file at the
 * project root (or src/) that calls `.listen()` during module startup,
 * and captures it as a single Vercel Function — every incoming request
 * is proxied to it through an internal port, so Nest's own router
 * (global 'api' prefix, every controller) handles all routing exactly
 * as it does locally. No vercel.json, rewrites, or /api directory
 * needed for this — it's Vercel's generic "Deploy a Node.js server"
 * mechanism, framework-agnostic:
 * https://vercel.com/docs/functions/runtimes/node-js#deploy-a-node.js-server
 *
 * Deliberately requires the COMPILED output rather than being (or
 * importing straight from) TypeScript source: Nest's dependency
 * injection relies on `emitDecoratorMetadata` (see tsconfig.json), which
 * only a real `tsc` compile produces — the esbuild-based TypeScript
 * transform Vercel uses for zero-config /api and server.ts files does
 * NOT emit it, so if Nest's decorated source were picked up and
 * compiled that way instead, constructor-injected dependencies could
 * fail to resolve. `npm run build` (this project's Vercel Build Command
 * — see package.json, runs `prisma generate && nest build`) already
 * produces dist/main.js with a real compiler before Vercel gets to this
 * file, so requiring it here sidesteps the problem entirely.
 *
 * Local/native/Docker dev is unaffected — `nest start` still runs
 * src/main.ts directly. `npm run start:prod` goes through this file too.
 *
 * Where the compiled entry lands (заход 12, аудит P2-2): `tsc` puts it at
 * dist/main.js only while every compiled file lives under src/. Since
 * `cron-schedule.ts` imports ../../../vercel.json (and the root
 * prisma.config.ts is in the program), rootDir becomes backend/ and the
 * entry is dist/src/main.js — `require('./dist/main.js')` alone threw
 * "Cannot find module". So: use whichever of the two exists; if both do
 * (dist is not wiped between builds — nest-cli.json `deleteOutDir: false`),
 * the newer one, so a stale leftover never wins. Both requires stay
 * literal string calls so Vercel's file tracer (@vercel/nft) still sees
 * them and bundles dist/ — the build itself is not changed.
 */
const fs = require('fs');
const path = require('path');

/** Модификация файла в мс или -1, если файла нет. */
function mtime(rel) {
  try {
    return fs.statSync(path.join(__dirname, rel)).mtimeMs;
  } catch {
    return -1;
  }
}

const flat = mtime('dist/main.js');
const nested = mtime('dist/src/main.js');
if (flat < 0 && nested < 0) {
  throw new Error(
    'backend/server.js: нет ни dist/main.js, ни dist/src/main.js — сначала `npm run build` (nest build)',
  );
}
if (flat >= nested) {
  require('./dist/main.js');
} else {
  require('./dist/src/main.js');
}
