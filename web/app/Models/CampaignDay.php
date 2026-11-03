<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use LogicException;

#[Fillable(['campaign_id', 'day_no', 'status', 'run_id', 'carry_in', 'plan', 'checkpoint', 'prev_hash', 'hash', 'closed_at', 'error'])]
class CampaignDay extends Model
{
    protected function casts(): array
    {
        return ['carry_in' => 'array', 'plan' => 'array', 'closed_at' => 'datetime'];
    }

    protected static function booted(): void
    {
        // Hari yang sudah ditutup adalah backup: checkpoint dan hash tidak boleh berubah atau dihapus.
        static::updating(function (CampaignDay $d) {
            if ($d->getOriginal('status') === 'closed' && $d->isDirty(['status', 'checkpoint', 'prev_hash', 'hash', 'run_id', 'carry_in', 'plan'])) {
                throw new LogicException('Hari yang sudah ditutup tidak dapat diubah.');
            }
        });
        static::deleting(function (CampaignDay $d) {
            if ($d->status === 'closed') {
                throw new LogicException('Hari yang sudah ditutup tidak dapat dihapus.');
            }
        });
    }

    /** @return BelongsTo<Campaign, $this> */
    public function campaign(): BelongsTo
    {
        return $this->belongsTo(Campaign::class);
    }

    /** @return BelongsTo<SimRun, $this> */
    public function run(): BelongsTo
    {
        return $this->belongsTo(SimRun::class, 'run_id');
    }

    /** @return array<string, mixed>|null */
    public function snapshot(): ?array
    {
        return $this->checkpoint === null ? null : json_decode($this->checkpoint, true, flags: JSON_THROW_ON_ERROR);
    }
}
