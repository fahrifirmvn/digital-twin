<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Data operasional per simulation run. Aset direferensikan lewat kode agar graf genealogi seragam.
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('scenarios', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->jsonb('params');
            $table->bigInteger('seed');
            $table->jsonb('kpi_result')->nullable();
            $table->timestamps();
        });

        Schema::create('sim_runs', function (Blueprint $table) {
            $table->id();
            $table->foreignId('scenario_id')->nullable()->constrained('scenarios');
            $table->string('kind', 20)->default('live'); // live, monte_carlo, ablation
            $table->bigInteger('seed');
            $table->jsonb('config_snapshot')->nullable();
            $table->string('status', 20)->default('pending');
            $table->timestampTz('sim_start')->nullable();
            $table->timestampTz('sim_end')->nullable();
            $table->timestamps();
        });

        Schema::create('tankers', function (Blueprint $table) {
            $table->id();
            $table->foreignId('run_id')->constrained('sim_runs')->cascadeOnDelete();
            $table->string('code', 30);
            $table->foreignId('farm_id')->constrained('farms');
            $table->decimal('volume_ton', 6, 2);
            $table->decimal('initial_temp_c', 4, 1);
            $table->timestampTz('eta_p50')->nullable();
            $table->timestampTz('eta_p80')->nullable();
            $table->timestampTz('eta_p90')->nullable();
            $table->string('status', 20); // on_the_way, queued, sampling, lab_test, released, rejected, unloading, stored
            $table->timestamps();
            $table->unique(['run_id', 'code']);
        });

        Schema::create('lab_tests', function (Blueprint $table) {
            $table->id();
            $table->foreignId('tanker_id')->constrained('tankers')->cascadeOnDelete();
            $table->string('test_type', 30);
            $table->timestampTz('started_at')->nullable();
            $table->timestampTz('finished_at')->nullable();
            $table->jsonb('results')->nullable(); // [{parameter, value, pass}]
            $table->string('analyst')->nullable();
            $table->timestamps();
        });

        Schema::create('batches', function (Blueprint $table) {
            $table->id();
            $table->foreignId('run_id')->constrained('sim_runs')->cascadeOnDelete();
            $table->string('code', 40);
            $table->string('type', 20); // raw, intermediate, fg
            $table->foreignId('tanker_id')->nullable()->constrained('tankers');
            $table->foreignId('sku_id')->nullable()->constrained('skus');
            $table->decimal('volume_ton', 8, 2);
            $table->string('status', 20);
            $table->boolean('is_demo')->default(true);
            $table->timestamps();
            $table->unique(['run_id', 'code']);
        });

        // Sisi graf transformasi: mixing/standardisasi menggabungkan atau memecah batch.
        Schema::create('batch_lineage', function (Blueprint $table) {
            $table->id();
            $table->foreignId('parent_batch_id')->constrained('batches')->cascadeOnDelete();
            $table->foreignId('child_batch_id')->constrained('batches')->cascadeOnDelete();
            $table->decimal('volume_ton', 8, 2);
            $table->unique(['parent_batch_id', 'child_batch_id']);
            $table->index('child_batch_id');
        });

        // Setiap perpindahan susu antar aset wajib punya baris di sini (PRD 8.2).
        Schema::create('transfer_events', function (Blueprint $table) {
            $table->id();
            $table->foreignId('run_id')->constrained('sim_runs')->cascadeOnDelete();
            $table->string('from_asset', 30);
            $table->string('to_asset', 30);
            $table->foreignId('batch_id')->constrained('batches');
            $table->decimal('volume_ton', 8, 2);
            $table->timestampTz('occurred_at');
            $table->index(['batch_id']);
            $table->index(['run_id', 'occurred_at']);
        });

        Schema::create('cip_events', function (Blueprint $table) {
            $table->id();
            $table->foreignId('run_id')->constrained('sim_runs')->cascadeOnDelete();
            $table->string('asset_code', 30);
            $table->string('type', 20);
            $table->timestampTz('started_at');
            $table->timestampTz('finished_at')->nullable();
            $table->boolean('is_scheduled')->default(true);
        });

        Schema::create('gate_decisions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('run_id')->constrained('sim_runs')->cascadeOnDelete();
            $table->string('gate', 4); // G1..G6
            $table->string('object_type', 20);
            $table->string('object_id', 40);
            $table->string('decision', 10); // pass, hold
            $table->text('reason')->nullable();
            $table->string('decided_by', 40); // gate_engine atau id user QA
            $table->timestampTz('decided_at');
            $table->index(['object_type', 'object_id']);
        });

        Schema::create('schedules', function (Blueprint $table) {
            $table->id();
            $table->foreignId('run_id')->constrained('sim_runs')->cascadeOnDelete();
            $table->string('name');
            $table->timestamps();
        });

        Schema::create('schedule_versions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('schedule_id')->constrained('schedules')->cascadeOnDelete();
            $table->unsignedInteger('version');
            $table->string('status', 20); // proposed, active, superseded
            $table->char('config', 1); // A, B, C, D (PRD 10.7)
            $table->string('created_by', 40);
            $table->jsonb('plan');
            $table->jsonb('kpi_predicted')->nullable();
            $table->foreignId('approved_by')->nullable()->constrained('users');
            $table->text('approval_reason')->nullable();
            $table->timestampTz('approved_at')->nullable();
            $table->timestamps();
            $table->unique(['schedule_id', 'version']);
        });
    }

    public function down(): void
    {
        foreach ([
            'schedule_versions', 'schedules', 'gate_decisions', 'cip_events', 'transfer_events',
            'batch_lineage', 'batches', 'lab_tests', 'tankers', 'sim_runs', 'scenarios',
        ] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
