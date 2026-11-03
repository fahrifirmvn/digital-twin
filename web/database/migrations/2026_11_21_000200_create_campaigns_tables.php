<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Kampanye = pabrik yang berjalan hari demi hari; tiap hari ditutup dengan checkpoint berantai hash.
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('campaigns', function (Blueprint $table) {
            $table->id();
            $table->string('name', 80);
            $table->bigInteger('seed');
            $table->date('start_date');
            $table->string('config', 1)->default('A');
            $table->string('scenario', 30)->default('normal');
            $table->jsonb('params'); // volume_ton, extra_bad, plant, dan parameter operasional
            $table->float('speed')->nullable(); // menit simulasi per detik; kosong = secepat mungkin
            $table->boolean('autoplay')->default(false);
            $table->unsignedSmallInteger('current_day')->default(1);
            $table->foreignId('parent_campaign_id')->nullable()->constrained('campaigns')->nullOnDelete();
            $table->unsignedSmallInteger('branched_from_day')->nullable();
            $table->unsignedBigInteger('created_by')->nullable()->index();
            $table->timestamps();
        });

        Schema::create('campaign_days', function (Blueprint $table) {
            $table->id();
            $table->foreignId('campaign_id')->constrained('campaigns')->cascadeOnDelete();
            $table->unsignedSmallInteger('day_no');
            $table->string('status', 10)->default('planned'); // planned, running, closed, failed
            $table->foreignId('run_id')->nullable()->constrained('sim_runs')->nullOnDelete();
            $table->jsonb('carry_in'); // maintenance yang berlanjut dari hari sebelumnya
            $table->jsonb('plan'); // maintenance yang diputuskan manusia untuk hari ini
            $table->text('checkpoint')->nullable(); // JSON kanonik; dihash apa adanya
            $table->string('prev_hash', 64)->default('');
            $table->string('hash', 64)->nullable();
            $table->timestampTz('closed_at')->nullable();
            $table->text('error')->nullable();
            $table->timestamps();
            $table->unique(['campaign_id', 'day_no']);
            $table->index('run_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('campaign_days');
        Schema::dropIfExists('campaigns');
    }
};
