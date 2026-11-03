<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use LogicException;

// Usulan Operator Agent (P2, P6). Isi usulan immutable; hanya status dan keputusan yang boleh berubah, dan hanya sesuai alur.
// status tidak ada di Fillable: perubahan status hanya lewat ProposalService.
#[Fillable(['uuid', 'campaign_id', 'day_no', 'kind', 'version', 'supersedes_uuid', 'mode', 'payload', 'rationale', 'evidence', 'evidence_hash', 'conversation_id', 'model_name', 'model_version', 'created_by'])]
class AgentProposal extends Model
{
    public const KIND_TANK_MAINTENANCE = 'tank_maintenance';

    /** Alur status; status akhir (approved, rejected, expired, superseded) tidak dapat berubah lagi. */
    public const TRANSITIONS = [
        'draft' => ['pending', 'superseded', 'expired'],
        'pending' => ['approved', 'rejected', 'expired', 'superseded'],
    ];

    private const IMMUTABLE = ['uuid', 'campaign_id', 'day_no', 'kind', 'version', 'supersedes_uuid', 'mode', 'payload', 'rationale', 'evidence', 'evidence_hash', 'conversation_id', 'model_name', 'model_version', 'created_by'];

    protected $attributes = ['status' => 'draft'];

    protected function casts(): array
    {
        return ['payload' => 'array', 'evidence' => 'array', 'submitted_at' => 'datetime', 'decided_at' => 'datetime'];
    }

    protected static function booted(): void
    {
        static::updating(function (AgentProposal $p) {
            if ($p->isDirty(self::IMMUTABLE)) {
                throw new LogicException('Isi usulan tidak dapat diubah; buat versi baru.');
            }
            if ($p->isDirty('status') && ! in_array($p->status, self::TRANSITIONS[$p->getOriginal('status')] ?? [], true)) {
                throw new LogicException("Status usulan tidak dapat berubah dari {$p->getOriginal('status')} ke {$p->status}.");
            }
            if (! $p->isDirty('status') && $p->isDirty(['decided_by', 'decided_at', 'decision_reason', 'submitted_by', 'submitted_at'])
                && ! in_array($p->getOriginal('status'), ['draft', 'pending'], true)) {
                throw new LogicException('Keputusan usulan yang sudah final tidak dapat diubah.');
            }
        });
        static::deleting(fn () => throw new LogicException('Usulan tidak dapat dihapus.'));
    }

    /** @return BelongsTo<Campaign, $this> */
    public function campaign(): BelongsTo
    {
        return $this->belongsTo(Campaign::class);
    }

    /** @return BelongsTo<User, $this> */
    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    /** @return array<string, mixed> */
    public function summary(bool $full = false): array
    {
        $out = [
            'id' => $this->uuid, 'campaign_id' => $this->campaign_id, 'day_no' => $this->day_no, 'kind' => $this->kind,
            'version' => $this->version, 'supersedes' => $this->supersedes_uuid, 'status' => $this->status, 'mode' => $this->mode,
            'label' => "DATA SINTETIS | mode {$this->mode}",
            'payload' => $this->payload, 'rationale' => $this->rationale,
            'whatif' => $this->evidence['changes'] ?? [],
            'created_by' => $this->created_by, 'created_at' => $this->created_at?->toIso8601String(),
            'submitted_at' => $this->submitted_at?->toIso8601String(),
            'decided_by' => $this->decided_by, 'decided_at' => $this->decided_at?->toIso8601String(), 'decision_reason' => $this->decision_reason,
        ];

        return $full ? $out + ['evidence' => $this->evidence, 'evidence_hash' => $this->evidence_hash, 'model_name' => $this->model_name, 'model_version' => $this->model_version] : $out;
    }
}
