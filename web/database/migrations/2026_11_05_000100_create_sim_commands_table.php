<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Mode Simulasi: run cabang (fork) dari run lain dan log perintah yang membentuknya.
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('sim_runs', function (Blueprint $table) {
            $table->foreignId('parent_run_id')->nullable()->constrained('sim_runs')->nullOnDelete();
            $table->float('fork_minute')->nullable(); // menit perintah terakhir yang ditambahkan
        });

        Schema::create('sim_commands', function (Blueprint $table) {
            $table->id();
            $table->foreignId('run_id')->constrained('sim_runs')->cascadeOnDelete();
            $table->unsignedSmallInteger('seq');
            $table->decimal('minute', 7, 2);
            $table->string('kind', 20); // ster_down, cip_delay, truck_surge
            $table->jsonb('args');
            $table->unsignedBigInteger('actor_id')->nullable();
            $table->string('actor_label', 80);
            $table->text('reason');
            $table->timestamp('created_at')->useCurrent();
            $table->unique(['run_id', 'seq']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('sim_commands');
        Schema::table('sim_runs', function (Blueprint $table) {
            $table->dropConstrainedForeignId('parent_run_id');
            $table->dropColumn('fork_minute');
        });
    }
};
