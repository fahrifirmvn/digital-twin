<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use RuntimeException;

// Hash dan urutan dihitung oleh trigger DB, jadi service ini hanya menyisipkan dan memverifikasi.
class AuditLogger
{
    public function record(string $actorType, ?string $actorId, string $action, array $payload = []): void
    {
        // Hash-chain hanya ada di PostgreSQL. Di luar itu (dev/test sqlite) dilewati, tidak pernah di produksi.
        if (DB::getDriverName() !== 'pgsql') {
            if (app()->isProduction()) {
                throw new RuntimeException('Audit log membutuhkan PostgreSQL');
            }
            Log::warning('audit log dilewati (bukan pgsql)', ['action' => $action]);

            return;
        }

        DB::table('audit_logs')->insert([
            'actor_type' => $actorType,
            'actor_id' => $actorId,
            'action' => $action,
            'payload' => json_encode($payload, JSON_THROW_ON_ERROR),
            'occurred_at' => now(), // ditimpa trigger, kolom NOT NULL
            'prev_hash' => '', // ditimpa trigger
            'hash' => '', // ditimpa trigger
        ]);
    }

    /** ID baris pertama yang rusak, atau null jika rantai utuh. */
    public function firstBrokenId(): ?int
    {
        $id = DB::selectOne('SELECT audit_logs_verify() AS id')->id;

        return $id === null ? null : (int) $id;
    }
}
