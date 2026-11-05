<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Simpan kontrak hasil asli supaya asisten dapat membaca run setelah Engine restart.
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('sim_runs', function (Blueprint $table) {
            $table->jsonb('result_payload')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('sim_runs', function (Blueprint $table) {
            $table->dropColumn('result_payload');
        });
    }
};
