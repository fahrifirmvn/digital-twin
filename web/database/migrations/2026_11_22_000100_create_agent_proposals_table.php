<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Usulan Operator Agent. Isi usulan tidak pernah diubah; revisi = baris baru dengan versi lebih tinggi.
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('agent_proposals', function (Blueprint $table) {
            $table->id();
            $table->uuid('uuid')->unique();
            $table->foreignId('campaign_id')->constrained('campaigns')->cascadeOnDelete();
            $table->unsignedSmallInteger('day_no');
            $table->string('kind', 30); // tank_maintenance
            $table->unsignedSmallInteger('version')->default(1);
            $table->uuid('supersedes_uuid')->nullable();
            $table->string('status', 12)->default('draft'); // draft, pending, approved, rejected, expired, superseded
            $table->string('mode', 10)->default('SIMULASI');
            $table->jsonb('payload'); // asset, minute, duration_min
            $table->text('rationale');
            $table->jsonb('evidence'); // snapshot what-if: baseline, kandidat, selisih, temuan
            $table->string('evidence_hash', 64);
            $table->uuid('conversation_id')->nullable();
            $table->string('model_name', 80)->nullable();
            $table->string('model_version', 80)->nullable();
            $table->unsignedBigInteger('created_by')->index();
            $table->unsignedBigInteger('submitted_by')->nullable();
            $table->timestampTz('submitted_at')->nullable();
            $table->unsignedBigInteger('decided_by')->nullable();
            $table->timestampTz('decided_at')->nullable();
            $table->text('decision_reason')->nullable();
            $table->timestamps();
            $table->index(['campaign_id', 'day_no', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('agent_proposals');
    }
};
