<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

// Denah buatan pengguna (mode membangun): jumlah modul pabrik. Menjalankannya selalu membuat run baru.
#[Fillable(['name', 'user_id', 'spec'])]
class Layout extends Model
{
    protected function casts(): array
    {
        return ['spec' => 'array'];
    }

    /** @return BelongsTo<User, $this> */
    public function owner(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }

    /** @return array<string,int> */
    public function plant(): array
    {
        return $this->spec['plant'] ?? [];
    }
}
