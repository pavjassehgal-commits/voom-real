/**
 * Embedded-Postgres harness: a real PGlite (PostgreSQL on WASM) database with
 * the repository's actual Supabase migrations applied in filename order
 * (the Supabase apply order).
 *
 * A minimal Supabase scaffold is created first so the unmodified migration
 * files apply verbatim:
 *   - auth schema with auth.users and auth.uid() (returns the JWT subject
 *     claim when a request is authenticated, NULL otherwise — same shape as
 *     the Supabase runtime);
 *   - storage.buckets (inserted by 0006/0008, updated by later migrations);
 *   - the anon / authenticated / service_role roles the migrations grant to.
 *
 * One Supabase-only statement is stubbed: `create extension "pgcrypto"` is
 * stripped because PGlite ships no contrib extensions — and nothing depends
 * on the extension, since gen_random_uuid() is a core function in
 * PostgreSQL 13+ (PGlite runs 18) and no pgcrypto function is ever called.
 *
 * Tests run as the superuser, which bypasses RLS and grants exactly like
 * Supabase's service_role path that the campaign build RPC runs under.
 */
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));

const SCAFFOLD = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;
`;

/** The migration file contents, with the stubbed extension statement removed. */
export function migrationSql(name) {
  const raw = readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
  return raw.replace(/^\s*create extension[^\n]*$/gim, "");
}

/**
 * Creates a fresh embedded database with every file in supabase/migrations
 * applied, in filename order. Returns the db plus the applied file names.
 */
export async function createSupabaseLite() {
  const db = new PGlite();
  await db.exec(SCAFFOLD);
  const applied = [];
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith(".sql")) continue;
    await db.exec(migrationSql(file));
    applied.push(file);
  }
  return { db, applied };
}
