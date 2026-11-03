<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;

#[Fillable(['run_id', 'seq', 'minute', 'kind', 'args', 'actor_id', 'actor_label', 'reason'])]
class SimCommand extends Model
{
    public $timestamps = false;

    protected function casts(): array
    {
        return ['args' => 'array', 'minute' => 'float'];
    }

    /** Bentuk yang diterima Engine (CommandIn). */
    public function toEngine(): array
    {
        return ['minute' => $this->minute, 'kind' => $this->kind, 'actor' => $this->actor_label, 'reason' => $this->reason] + ($this->args ?? []);
    }
}
