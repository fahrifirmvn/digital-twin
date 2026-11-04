<?php

namespace App\Http\Controllers;

use App\Models\Campaign;
use App\Services\CampaignService;
use App\Services\OperationService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

// Kampanye harian: pabrik yang terus berjalan, tiap hari punya checkpoint yang bisa diputar ulang atau dipulihkan sebagai cabang.
class CampaignController extends Controller
{
    public function index()
    {
        $campaigns = Campaign::withCount(['days as closed_days' => fn ($q) => $q->where('status', 'closed')])->latest('id')->limit(50)->get();

        return view('campaigns.index', ['campaigns' => $campaigns]);
    }

    public function store(Request $request, CampaignService $campaigns)
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'min:3', 'max:80'],
            'seed' => ['required', 'integer', 'min:0', 'max:2147483647'],
            'config' => ['required', Rule::in(array_keys(config('twin.configs')))],
            'scenario' => ['required', Rule::in(array_keys(config('twin.scenarios')))],
            'volume_ton' => ['required', 'numeric', 'min:50', 'max:600'],
            'extra_bad' => ['required', 'integer', 'min:0', 'max:10'],
            'speed' => ['nullable', Rule::in(array_filter(array_keys(config('twin.campaign.speeds')), fn ($k) => $k !== ''))],
            'start_date' => ['required', 'date'],
        ]);
        $c = $campaigns->create($request->user(), [
            'name' => $data['name'], 'seed' => $data['seed'], 'start_date' => $data['start_date'], 'config' => $data['config'], 'scenario' => $data['scenario'],
            'params' => ['volume_ton' => (float) $data['volume_ton'], 'extra_bad' => (int) $data['extra_bad']],
            'speed' => isset($data['speed']) ? (float) $data['speed'] : null,
        ]);

        return redirect()->route('campaigns.show', $c);
    }

    public function show(Campaign $campaign, CampaignService $campaigns)
    {
        $days = $campaign->days()->with('run:id,status')->get();
        $current = $days->firstWhere('day_no', $campaign->current_day);

        return view('campaigns.show', [
            'campaign' => $campaign, 'days' => $days, 'current' => $current,
            'integrity' => $campaigns->verify($campaign),
            'tanks' => $this->tanks($campaign),
        ]);
    }

    public function state(Campaign $campaign): JsonResponse
    {
        $current = $campaign->days()->where('day_no', $campaign->current_day)->first();

        return response()->json([
            'current_day' => $campaign->current_day, 'autoplay' => $campaign->autoplay,
            'closed' => $campaign->days()->where('status', 'closed')->count(),
            'status' => $current?->status, 'run_id' => $current?->run_id,
        ]);
    }

    public function start(Campaign $campaign, CampaignService $campaigns)
    {
        $day = $campaigns->startDay($campaign, request()->user());

        return redirect()->route('campaigns.show', $campaign)->with('started', $day->run_id);
    }

    public function plan(Request $request, Campaign $campaign, CampaignService $campaigns)
    {
        [$min, $max] = config('twin.campaign.maintenance_minutes');
        $data = $request->validate([
            'asset' => ['required', 'string', 'regex:/^TK-(RAW|STO)-\d{1,2}$/'],
            'start_min' => ['required', 'numeric', 'min:0', 'lt:'.CampaignService::DAY_MIN],
            'duration_min' => ['required', 'numeric', "min:$min", "max:$max"],
            'reason' => ['required', 'string', 'min:5', 'max:200'],
        ]);
        $day = $campaigns->planMaintenance($campaign, $request->user(), $data['asset'], (float) $data['start_min'], (float) $data['duration_min'], $data['reason']);
        if ($request->expectsJson()) {
            return response()->json(['ok' => true, 'day' => $day->day_no] + app(OperationService::class)->state($campaign->refresh()), 201);
        }

        return redirect()->route('campaigns.show', $campaign);
    }

    public function cancel(Request $request, Campaign $campaign, int $index, CampaignService $campaigns)
    {
        $day = $campaigns->cancelMaintenance($campaign, $request->user(), $index);
        if ($request->expectsJson()) {
            return response()->json(['ok' => true, 'day' => $day->day_no] + app(OperationService::class)->state($campaign->refresh()));
        }

        return redirect()->route('campaigns.show', $campaign);
    }

    public function autoplay(Request $request, Campaign $campaign, CampaignService $campaigns)
    {
        $on = $request->boolean('on');
        $campaigns->setAutoplay($campaign, $request->user(), $on);
        if ($on && $campaign->days()->where('day_no', $campaign->current_day)->value('status') === 'planned') {
            $campaigns->startDay($campaign, $request->user());
        }

        return redirect()->route('campaigns.show', $campaign);
    }

    public function branch(Request $request, Campaign $campaign, CampaignService $campaigns)
    {
        $day = $request->validate(['day' => ['required', 'integer', 'min:1']])['day'];
        $branch = $campaigns->branch($campaign, (int) $day, $request->user());

        return redirect()->route('campaigns.show', $branch);
    }

    /** @return list<string> */
    private function tanks(Campaign $c): array
    {
        $plant = $c->params['plant'] ?? [];
        $raw = $plant['n_raw_tanks'] ?? config('twin.commands.tanks.TK-RAW');
        $sto = $plant['n_storage_tanks'] ?? config('twin.commands.tanks.TK-STO');

        return [...array_map(fn ($i) => "TK-RAW-$i", range(1, $raw)), ...array_map(fn ($i) => "TK-STO-$i", range(1, $sto))];
    }
}
