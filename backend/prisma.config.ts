// Prisma 7 config file.
//
// This file is read ONLY by the Prisma CLI (`prisma migrate`,
// `prisma db pull`, `prisma studio`, etc.) — never by the running app.
// Prisma 7 deprecated the `url`/`directUrl`/`shadowDatabaseUrl` fields on
// schema.prisma's `datasource` block; connection strings for CLI commands
// now live here instead, and the running PrismaClient gets its own
// connection via an explicit driver adapter (see
// backend/src/prisma/prisma.service.ts) rather than reading anything from
// this file or from schema.prisma.
//
// `datasource.url` below intentionally reads DIRECT_URL, not DATABASE_URL:
// migrations need a direct (non-pooled) Postgres connection — the exact
// role `directUrl` used to play in schema.prisma before Prisma 7 (see
// doc/PRISMA-SUPABASE.md). The app itself keeps using the POOLED
// DATABASE_URL via PrismaService's adapter; this file has no effect on
// that connection at all.
//
// `import 'dotenv/config'` picks up backend/.env when this runs natively
// (outside Docker — see doc/LOCAL-DEVELOPMENT.md's "Вариант Б"), where
// env vars aren't already injected by docker-compose; it's a harmless
// no-op if no .env file is present (e.g. inside the Docker image, where
// docker-compose's `environment:` already sets these directly).
import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: path.join(__dirname, 'prisma/schema.prisma'),
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
});
