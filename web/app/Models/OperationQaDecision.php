<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;

#[Fillable(['id', 'run_id', 'actor_id', 'actor_label', 'truck', 'action', 'reason', 'status', 'request', 'receipt', 'error'])]
class OperationQaDecision extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected function casts(): array
    {
        return ['request' => 'array', 'receipt' => 'array'];
    }
}
