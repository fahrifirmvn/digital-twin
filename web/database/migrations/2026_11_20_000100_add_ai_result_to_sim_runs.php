<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Prediksi model AI (ETA, lab, QC, anomali; data sintetis) dari hasil run, apa adanya dari kontrak.
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('sim_runs', function (Blueprint $table) {
            $table->jsonb('ai_result')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('sim_runs', function (Blueprint $table) {
            $table->dropColumn('ai_result');
        });
    }
};
