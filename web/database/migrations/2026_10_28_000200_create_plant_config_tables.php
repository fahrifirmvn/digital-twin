<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Konfigurasi statis pabrik. Semua baris berlabel DEMO (PRD 9.2).
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('assumptions', function (Blueprint $table) {
            $table->id();
            $table->string('key')->unique();
            $table->jsonb('value');
            $table->string('unit', 30)->nullable();
            $table->text('note')->nullable();
            $table->boolean('is_demo')->default(true);
            $table->timestamps();
        });

        Schema::create('farms', function (Blueprint $table) {
            $table->id();
            $table->string('code', 30)->unique();
            $table->string('name');
            $table->decimal('distance_km', 6, 1);
            $table->decimal('avg_volume_ton', 6, 2);
            $table->boolean('is_demo')->default(true);
            $table->timestamps();
        });

        // Bay unloading. Status runtime ada di state simulasi, bukan di sini.
        Schema::create('bays', function (Blueprint $table) {
            $table->id();
            $table->string('code', 30)->unique();
            $table->decimal('flow_rate_max_tph', 6, 2);
            $table->boolean('is_demo')->default(true);
            $table->timestamps();
        });

        Schema::create('tanks', function (Blueprint $table) {
            $table->id();
            $table->string('code', 30)->unique();
            $table->string('type', 20); // raw_buffer, storage, cream, aseptic
            $table->decimal('capacity_ton', 8, 2);
            $table->boolean('is_demo')->default(true);
            $table->timestamps();
        });

        Schema::create('process_units', function (Blueprint $table) {
            $table->id();
            $table->string('code', 30)->unique();
            $table->string('type', 20); // degassing, thermal, separator, sterilizer, mixer, premix
            $table->decimal('capacity_tph', 8, 2);
            $table->jsonb('maintenance_windows')->nullable();
            $table->boolean('is_demo')->default(true);
            $table->timestamps();
        });

        Schema::create('skus', function (Blueprint $table) {
            $table->id();
            $table->string('code', 30)->unique();
            $table->string('name');
            $table->string('size_ml', 10);
            $table->string('flavor', 30);
            $table->string('package_type', 30);
            $table->boolean('is_demo')->default(true);
            $table->timestamps();
        });

        // Satu aseptic tank melayani dua filling line (PRD 9.1).
        Schema::create('filling_lines', function (Blueprint $table) {
            $table->id();
            $table->string('code', 30)->unique();
            $table->foreignId('aseptic_tank_id')->constrained('tanks');
            $table->decimal('speed_tph', 8, 2);
            $table->boolean('is_demo')->default(true);
            $table->timestamps();
        });

        Schema::create('sku_changeover_rules', function (Blueprint $table) {
            $table->id();
            $table->foreignId('from_sku_id')->constrained('skus');
            $table->foreignId('to_sku_id')->constrained('skus');
            $table->unsignedSmallInteger('base_minutes');
            $table->string('driver', 20); // paper, size, flavor
            $table->boolean('is_demo')->default(true);
            $table->timestamps();
            $table->unique(['from_sku_id', 'to_sku_id']);
        });

        Schema::create('constraint_sets', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->unsignedInteger('version')->default(1);
            $table->jsonb('hard_rules');
            $table->jsonb('preferences')->nullable();
            $table->boolean('is_active')->default(false);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        foreach ([
            'constraint_sets', 'sku_changeover_rules', 'filling_lines', 'skus',
            'process_units', 'tanks', 'bays', 'farms', 'assumptions',
        ] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
