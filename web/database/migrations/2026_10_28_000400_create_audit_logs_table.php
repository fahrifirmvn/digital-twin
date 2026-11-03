<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

// Rantai hash dihitung di DB agar Laravel dan Engine memakai satu jalur tulis yang sama (PRD 8.3).
return new class extends Migration
{
    public function up(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            return;
        }

        DB::unprepared(<<<'SQL'
CREATE TABLE audit_logs (
    id          bigint PRIMARY KEY,
    occurred_at timestamptz NOT NULL,
    actor_type  varchar(10) NOT NULL CHECK (actor_type IN ('user','engine','llm','system')),
    actor_id    varchar(40),
    action      varchar(60) NOT NULL,
    payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
    prev_hash   char(64) NOT NULL,
    hash        char(64) NOT NULL
);

CREATE SEQUENCE audit_logs_id_seq OWNED BY audit_logs.id;

CREATE FUNCTION audit_logs_hash_input(prev text, pl jsonb, ts timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT prev || pl::text || to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- id diambil setelah lock agar urutan id selalu sama dengan urutan rantai.
CREATE FUNCTION audit_logs_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    last_hash text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('audit_logs'));
    SELECT hash INTO last_hash FROM audit_logs ORDER BY id DESC LIMIT 1;
    NEW.id          := nextval('audit_logs_id_seq');
    NEW.occurred_at := clock_timestamp();
    NEW.prev_hash   := COALESCE(last_hash, repeat('0', 64));
    NEW.hash        := encode(sha256(convert_to(
        audit_logs_hash_input(NEW.prev_hash, NEW.payload, NEW.occurred_at), 'UTF8')), 'hex');
    RETURN NEW;
END $$;

CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_before_insert();

CREATE FUNCTION audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only';
END $$;

CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

-- Mengembalikan id baris pertama yang tidak cocok, NULL jika rantai utuh.
CREATE FUNCTION audit_logs_verify() RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
    r record;
    expected_prev text := repeat('0', 64);
BEGIN
    FOR r IN SELECT * FROM audit_logs ORDER BY id LOOP
        IF r.prev_hash <> expected_prev OR r.hash <> encode(sha256(convert_to(
            audit_logs_hash_input(r.prev_hash, r.payload, r.occurred_at), 'UTF8')), 'hex') THEN
            RETURN r.id;
        END IF;
        expected_prev := r.hash;
    END LOOP;
    RETURN NULL;
END $$;
SQL);
    }

    public function down(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            return;
        }

        DB::unprepared(<<<'SQL'
DROP TABLE IF EXISTS audit_logs;
DROP FUNCTION IF EXISTS audit_logs_verify();
DROP FUNCTION IF EXISTS audit_logs_immutable();
DROP FUNCTION IF EXISTS audit_logs_before_insert();
DROP FUNCTION IF EXISTS audit_logs_hash_input(text, jsonb, timestamptz);
DROP SEQUENCE IF EXISTS audit_logs_id_seq;
SQL);
    }
};
