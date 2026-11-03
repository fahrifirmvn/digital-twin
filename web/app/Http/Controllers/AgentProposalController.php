<?php

namespace App\Http\Controllers;

use App\Models\AgentProposal;
use App\Services\ProposalService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

// Usulan Operator Agent. Membaca dan mengajukan terbuka bagi pengguna twin; menyetujui/menolak hanya PPIC/Admin
// (middleware can:approve-proposal) dan selalu dengan alasan.
class AgentProposalController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $data = $request->validate([
            'campaign_id' => ['required', 'integer', 'min:1'],
            'status' => ['sometimes', 'in:draft,pending,approved,rejected,expired,superseded'],
        ]);
        $rows = AgentProposal::where('campaign_id', $data['campaign_id'])
            ->when($data['status'] ?? null, fn ($q, $s) => $q->where('status', $s))
            ->orderByDesc('id')->limit(50)->get();

        return response()->json(['proposals' => $rows->map->summary()->all()]);
    }

    public function show(string $uuid): JsonResponse
    {
        return response()->json(['proposal' => $this->find($uuid)->summary(full: true)]);
    }

    public function submit(Request $request, string $uuid, ProposalService $service): JsonResponse
    {
        $p = $this->find($uuid);
        abort_unless($p->created_by === $request->user()->id || Gate::allows('approve-proposal'), 403);

        return response()->json(['proposal' => $service->submit($p, $request->user())->summary()]);
    }

    public function approve(Request $request, string $uuid, ProposalService $service): JsonResponse
    {
        $data = $this->reason($request);

        return response()->json(['proposal' => $service->approve($this->find($uuid), $request->user(), $data['reason'])->summary()]);
    }

    public function reject(Request $request, string $uuid, ProposalService $service): JsonResponse
    {
        $data = $this->reason($request);

        return response()->json(['proposal' => $service->reject($this->find($uuid), $request->user(), $data['reason'])->summary()]);
    }

    /** @return array{reason: string} */
    private function reason(Request $request): array
    {
        return $request->validate(['reason' => ['required', 'string', 'min:5', 'max:500']]);
    }

    private function find(string $uuid): AgentProposal
    {
        return AgentProposal::where('uuid', $uuid)->firstOrFail();
    }
}
