<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Agen Copilot (P6): mandat tingkat otomasi dari PPIC dan jejak tiap tindakan agen (cabang kandidat + verifikasi).
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('agent_mandates', function (Blueprint $table) {
            $table->id();
            $table->unsignedTinyInteger('level'); // 0 mati, 1 saran, 2 otomatis + veto, 3 otomatis penuh
            $table->unsignedTinyInteger('max_actions'); // perintah maksimal per tindakan
            $table->text('reason');
            $table->foreignId('set_by')->constrained('users');
            $table->timestamp('created_at')->useCurrent();
        });

        Schema::create('agent_actions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('run_id')->constrained('sim_runs')->cascadeOnDelete();
            $table->foreignId('fork_run_id')->nullable()->constrained('sim_runs')->nullOnDelete();
            $table->foreignId('mandate_id')->nullable()->constrained('agent_mandates')->nullOnDelete();
            $table->unsignedTinyInteger('level');
            $table->float('minute');
            $table->string('status', 12); // verifying, awaiting, applied, rejected, vetoed, undone
            $table->jsonb('commands');
            $table->jsonb('verdict')->nullable();
            $table->string('decided_by', 80)->nullable();
            $table->text('decided_reason')->nullable();
            $table->timestamp('veto_until')->nullable();
            $table->foreignId('requested_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
            $table->index(['run_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('agent_actions');
        Schema::dropIfExists('agent_mandates');
    }
};
