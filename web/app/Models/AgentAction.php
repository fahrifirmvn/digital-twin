<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;

#[Fillable(['run_id', 'fork_run_id', 'mandate_id', 'level', 'minute', 'status', 'commands', 'verdict', 'decided_by', 'decided_reason', 'veto_until', 'requested_by'])]
class AgentAction extends Model
{
    protected function casts(): array
    {
        return ['commands' => 'array', 'verdict' => 'array', 'minute' => 'float', 'veto_until' => 'datetime'];
    }

    /** Veto agen otomatis hanya selama jendela terbuka; setelahnya yang tersisa adalah Batalkan. */
    public function vetoOpen(): bool
    {
        return $this->status === 'applied' && $this->veto_until !== null && $this->veto_until->isFuture();
    }
}
