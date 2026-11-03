<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::dropIfExists('agent_actions');
        Schema::dropIfExists('agent_mandates');
    }

    public function down(): void {}
};
