<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

#[Fillable(['level', 'max_actions', 'reason', 'set_by'])]
class AgentMandate extends Model
{
    public const UPDATED_AT = null;

    /** @return BelongsTo<User, $this> */
    public function setter(): BelongsTo
    {
        return $this->belongsTo(User::class, 'set_by');
    }

    /** Mandat terbaru; bila belum pernah ditetapkan agen mati (tingkat 0). */
    public static function current(): ?self
    {
        return static::query()->latest('id')->first();
    }

    public static function currentLevel(): int
    {
        return (int) (static::current()?->level ?? 0);
    }
}
