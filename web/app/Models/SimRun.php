<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

#[Fillable(['kind', 'seed', 'config_snapshot', 'status', 'requested_by', 'error', 'parent_run_id', 'fork_minute'])]
class SimRun extends Model
{
    protected function casts(): array
    {
        return ['config_snapshot' => 'array', 'sim_start' => 'datetime', 'sim_end' => 'datetime', 'fork_minute' => 'float', 'ai_result' => 'array'];
    }

    /** @return HasMany<SimCommand, $this> */
    public function commands(): HasMany
    {
        return $this->hasMany(SimCommand::class, 'run_id')->orderBy('seq');
    }

    /** Jumlah modul yang diubah dari pabrik bawaan; kosong = pabrik bawaan. */
    public function plant(): array
    {
        return $this->config_snapshot['params']['plant'] ?? [];
    }

    public function isSimulation(): bool
    {
        return $this->kind === 'simulation';
    }

    /**
     * Label asal data di topbar: sandbox simulasi, run yang sedang mengalir, atau hasil run yang sudah selesai.
     *
     * @return array{key:string, label:string}
     */
    public function modeBadge(): array
    {
        if ($this->isSimulation() || $this->kind === 'campaign') {
            return ['key' => 'sim', 'label' => 'SIMULASI'];
        }
        if (in_array($this->status, ['pending', 'running'], true)) {
            return ['key' => 'live', 'label' => 'LIVE'];
        }

        return ['key' => 'sample', 'label' => 'DATA CONTOH'];
    }
}
