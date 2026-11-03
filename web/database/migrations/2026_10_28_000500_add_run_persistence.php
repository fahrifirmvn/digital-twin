<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Log event per run untuk replay di browser, plus kolom status hasil run.
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('sim_events', function (Blueprint $table) {
            $table->id();
            $table->foreignId('run_id')->constrained('sim_runs')->cascadeOnDelete();
            $table->unsignedInteger('seq');
            $table->timestampTz('sim_time');
            $table->string('type', 40);
            $table->jsonb('payload');
            $table->unique(['run_id', 'seq']);
        });

        Schema::table('sim_runs', function (Blueprint $table) {
            $table->unsignedBigInteger('requested_by')->nullable()->index();
            $table->text('error')->nullable();
        });

        Schema::table('tankers', function (Blueprint $table) {
            $table->string('outcome', 20)->default('in_progress'); // completed, held_g1, rejected_g2, held_qa
        });
    }

    public function down(): void
    {
        Schema::table('tankers', function (Blueprint $table) {
            $table->dropColumn('outcome');
        });
        Schema::table('sim_runs', function (Blueprint $table) {
            $table->dropIndex(['requested_by']);
            $table->dropColumn(['requested_by', 'error']);
        });
        Schema::dropIfExists('sim_events');
    }
};
