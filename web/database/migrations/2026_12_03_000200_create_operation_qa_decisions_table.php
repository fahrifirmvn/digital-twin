<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('operation_qa_decisions', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignId('run_id')->constrained('sim_runs');
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_label', 80);
            $table->string('truck', 30);
            $table->string('action', 12);
            $table->string('reason', 200);
            $table->string('status', 20);
            $table->jsonb('request');
            $table->jsonb('receipt')->nullable();
            $table->text('error')->nullable();
            $table->timestamps();
            $table->index(['run_id', 'truck']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('operation_qa_decisions');
    }
};
