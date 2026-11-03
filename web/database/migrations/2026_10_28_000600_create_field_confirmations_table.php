<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Konfirmasi lapangan (check-in truk, serah terima) dari Driver PWA / Operator View.
// uuid dibuat di perangkat agar kirim ulang setelah offline tidak menggandakan baris.
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('field_confirmations', function (Blueprint $table) {
            $table->id();
            $table->uuid('uuid')->unique();
            $table->foreignId('run_id')->constrained('sim_runs')->cascadeOnDelete();
            $table->string('kind', 20); // check_in, handoff
            $table->string('subject', 60); // kode truk, atau "RT-001:unload"
            $table->foreignId('user_id')->constrained('users');
            $table->timestampTz('client_at'); // waktu di perangkat, bisa tertunda
            $table->timestampTz('created_at'); // waktu server menerima
            $table->unique(['run_id', 'kind', 'subject']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('field_confirmations');
    }
};
