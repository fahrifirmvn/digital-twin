<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

// Hasil hari operasi: nomor hari, ringkasan akhir hari, dan keadaan yang terbawa ke hari berikut (apa adanya dari engine).
// Run lama sebelum operasi harian diarsipkan: tetap ada untuk audit, tetapi tidak tampil sebagai pilihan.
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('sim_runs', function (Blueprint $table) {
            $table->jsonb('day_result')->nullable();
            $table->timestamp('archived_at')->nullable();
        });
        // Hari operasi yang sedang ditonton; hari berikutnya disiapkan satu langkah di depan, tidak lebih.
        Schema::table('campaigns', function (Blueprint $table) {
            $table->unsignedInteger('watch_day')->nullable();
        });
        DB::table('sim_runs')->whereNull('archived_at')->whereIn('kind', ['live', 'simulation'])->update(['archived_at' => now()]);
    }

    public function down(): void
    {
        Schema::table('sim_runs', function (Blueprint $table) {
            $table->dropColumn(['day_result', 'archived_at']);
        });
        Schema::table('campaigns', function (Blueprint $table) {
            $table->dropColumn('watch_day');
        });
    }
};
