<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('operation_maintenance', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignId('campaign_id')->constrained('campaigns');
            $table->unsignedSmallInteger('day_no');
            $table->foreignId('run_id')->nullable()->constrained('sim_runs');
            $table->string('asset', 30);
            $table->string('mode', 12);
            $table->float('start_min')->nullable();
            $table->float('duration_min');
            $table->string('reason', 200);
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_label', 80);
            $table->string('status', 20);
            $table->text('error')->nullable();
            $table->jsonb('request');
            $table->timestamps();
            $table->index(['campaign_id', 'day_no']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('operation_maintenance');
    }
};
