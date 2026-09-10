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
 * Local/native/Docker dev is unaffected — this file is Vercel-only.
 * `nest start` / `node dist/main` (see package.json scripts) still run
 * src/main.ts directly, same as before this fix.
 */
require('./dist/main.js');
