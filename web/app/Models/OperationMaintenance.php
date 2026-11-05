<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;

#[Fillable(['id', 'campaign_id', 'day_no', 'run_id', 'asset', 'mode', 'start_min', 'duration_min', 'reason', 'actor_id', 'actor_label', 'status', 'error', 'request'])]
class OperationMaintenance extends Model
{
    protected $table = 'operation_maintenance';

    public $incrementing = false;

    protected $keyType = 'string';

    protected function casts(): array
    {
        return ['request' => 'array', 'start_min' => 'float', 'duration_min' => 'float'];
    }
}
