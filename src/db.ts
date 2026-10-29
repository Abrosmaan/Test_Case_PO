import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
create table if not exists documents (
  id integer primary key autoincrement,
  filename text not null,
  sha256 text not null unique,
  encoding text not null,
  text text not null,
  doc_type text,
  doc_no text,
  contract_no text,
  sign_status text,
  doc_date text,
  signed_date text,
  effective_date text,
  classified_by text,
  needs_review integer not null default 0,
  review_reason text,
  llm_status text,               -- null | disabled | failed | ok
  llm_suggestion text,           -- JSON: provider, model, doc_type, contract_no, quote
  created_at text not null default (datetime('now'))
);
create table if not exists paragraphs (
  id integer primary key autoincrement,
  document_id integer not null references documents(id) on delete cascade,
  clause_no text,
  line_no integer not null,
  start integer not null,
  "end" integer not null,
  text text not null
);
create index if not exists paragraphs_doc on paragraphs(document_id);
create table if not exists facts (
  id integer primary key autoincrement,
  document_id integer not null references documents(id) on delete cascade,
  paragraph_id integer references paragraphs(id),
  field text not null,
  kind text not null,            -- fact | no_data
  value text,
  display text,
  quote text,
  start integer,
  "end" integer,
  rule_id text not null,
  replaces_clause text,
  reason text
);
create index if not exists facts_doc on facts(document_id);
create table if not exists trace (
  id integer primary key autoincrement,
  batch_id text,
  document_id integer,
  stage text not null,
  rule_id text,
  message text not null,
  data text,
  created_at text not null default (datetime('now'))
);
create index if not exists trace_doc on trace(document_id);
`;

/** Opens (or creates) the database; schema creation is idempotent. Use ':memory:' for tests/CLI. */
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('pragma foreign_keys = on;');
  db.exec(SCHEMA);
  // Columns added after the first release: databases created earlier get them here.
  const cols = new Set((db.prepare('pragma table_info(documents)').all() as { name: string }[]).map((c) => c.name));
  for (const col of ['llm_status', 'llm_suggestion']) if (!cols.has(col)) db.exec(`alter table documents add column ${col} text`);
  return db;
}
