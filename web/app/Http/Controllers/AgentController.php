<?php

namespace App\Http\Controllers;

use App\Models\AgentAction;
use App\Models\AgentMandate;
use App\Models\SimRun;
use App\Services\AgentService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

// Agen Copilot (P6): umpan tindakan agen per run, mandat tingkat otomasi (PPIC), dan keputusan manusia atas tindakan agen.
class AgentController extends Controller
{
    public function state(Request $request, SimRun $run, AgentService $agent): JsonResponse
    {
        $actions = AgentAction::where('run_id', $run->id)->orderByDesc('id')->limit(20)->get()->map(fn ($a) => $agent->present($agent->settle($a)));
        $mandate = AgentMandate::current();
        $user = $request->user();

        return response()->json([
            'mandate' => [
                'level' => (int) ($mandate?->level ?? 0),
                'max_actions' => (int) ($mandate?->max_actions ?? config('twin.agent.max_actions.default')),
                'reason' => $mandate?->reason, 'by' => $mandate?->setter?->name, 'at' => $mandate?->created_at?->toIso8601String(),
            ],
            'levels' => config('twin.agent.levels'),
            'limits' => ['max_actions' => config('twin.agent.max_actions.max'), 'veto_seconds' => config('twin.agent.veto_seconds')],
            'can' => ['mandate' => $user->can('set-agent-mandate'), 'act' => $user->can('intervene')],
            'actions' => $actions->values(),
        ]);
    }

    public function mandate(Request $request, AgentService $agent): JsonResponse
    {
        $max = config('twin.agent.max_actions.max');
        $data = $request->validate([
            'level' => ['required', 'integer', 'between:0,3'],
            'max_actions' => ['required', 'integer', "between:1,{$max}"],
            'reason' => ['required', 'string', 'min:5', 'max:300'],
        ]);
        $m = $agent->setMandate($request->user(), (int) $data['level'], (int) $data['max_actions'], $data['reason']);

        return response()->json(['level' => $m->level, 'max_actions' => $m->max_actions], 201);
    }

    public function run(Request $request, SimRun $run, AgentService $agent): JsonResponse
    {
        $data = $request->validate(['minute' => ['required', 'numeric', 'min:0', 'lt:1440']]);
        $action = $agent->propose($run, (float) $data['minute'], $request->user());

        return response()->json($agent->present($action), 201);
    }

    public function approve(Request $request, AgentAction $action, AgentService $agent): JsonResponse
    {
        return response()->json($agent->present($agent->approve($action, $request->user(), $this->reason($request))));
    }

    public function veto(Request $request, AgentAction $action, AgentService $agent): JsonResponse
    {
        return response()->json($agent->present($agent->veto($action, $request->user(), $this->reason($request))));
    }

    public function undo(Request $request, AgentAction $action, AgentService $agent): JsonResponse
    {
        return response()->json($agent->present($agent->undo($action, $request->user(), $this->reason($request))));
    }

    private function reason(Request $request): string
    {
        return $request->validate(['reason' => ['required', 'string', 'min:5', 'max:300']])['reason'];
    }
}
