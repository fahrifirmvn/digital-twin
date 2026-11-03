<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

#[Fillable(['name', 'seed', 'start_date', 'config', 'scenario', 'params', 'speed', 'autoplay', 'current_day', 'watch_day', 'parent_campaign_id', 'branched_from_day', 'created_by'])]
class Campaign extends Model
{
    protected function casts(): array
    {
        return ['params' => 'array', 'start_date' => 'date', 'speed' => 'float', 'autoplay' => 'boolean'];
    }

    /** @return HasMany<CampaignDay, $this> */
    public function days(): HasMany
    {
        return $this->hasMany(CampaignDay::class)->orderBy('day_no');
    }

    public function dateOf(int $dayNo): string
    {
        return $this->start_date->copy()->addDays($dayNo - 1)->toDateString();
    }

    /** Seed hari: sama untuk semua cabang kampanye, jadi hari yang sama selalu menghasilkan truk yang sama. */
    public function daySeed(int $dayNo): int
    {
        return ($this->seed + $dayNo - 1) % 2147483647;
    }
}
