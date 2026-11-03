<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\SimRun;
use App\Models\User;
use App\Services\DaySchedule;
use App\Services\HoldingAlerts;
use App\Services\OrderFeasibility;
use App\Services\VolumeBalance;
use App\Services\WearReport;
use Database\Seeders\MasterDataSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

// Navigasi Dashboard / Digital Twin / Maps memakai contoh hasil nyata dari Engine.
class DashboardPagesTest extends TestCase
{
    use RefreshDatabase;

    private array $sample;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        config(['services.engine.token' => 'secret']);
        $this->seed(MasterDataSeeder::class);
        $this->sample = json_decode(file_get_contents(base_path('../contracts/run-result.sample.json')), true, flags: JSON_THROW_ON_ERROR);
    }

    private function as(Role $role): static
    {
        return $this->actingAs(User::factory()->role($role)->create());
    }

    private function finishedRun(int $id): SimRun
    {
        SimRun::forceCreate(['id' => $id, 'kind' => 'live', 'seed' => 1, 'status' => 'running']);
        $result = ['run_id' => $id] + $this->sample;
        $result['events'] = array_map(fn ($e) => ['run_id' => $id] + $e, $this->sample['events']);
        $this->postJson("/internal/runs/{$id}/result", $result, ['X-Internal-Token' => 'secret'])->assertOk();

        return SimRun::find($id);
    }

    public function test_root_goes_to_twin_for_full_roles_and_dashboard_for_others(): void
    {
        $this->get('/')->assertRedirect('/login');
        $this->as(Role::Ppic)->get('/')->assertRedirect(route('twin'));
        $this->as(Role::Driver)->get('/')->assertRedirect(route('dashboard'));
    }

    public function test_run_detail_shows_ai_panel_labelled_synthetic(): void
    {
        $run = $this->finishedRun(7);
        $this->as(Role::Ppic)->get(route('runs.show', $run))
            ->assertOk()->assertSee('Prediksi AI')->assertSee('DATA SINTETIS')->assertSee('Anomali pabrik');
    }

    public function test_pages_without_any_run_show_empty_state(): void
    {
        $this->as(Role::Ppic);
        foreach (['/dashboard', '/twin', '/maps'] as $url) {
            $this->get($url)->assertOk()->assertSee('Belum ada run simulasi');
        }
    }

    public function test_default_run_is_latest_finished_and_query_overrides(): void
    {
        $first = $this->finishedRun(1);
        $this->finishedRun(2);
        SimRun::forceCreate(['id' => 3, 'kind' => 'live', 'seed' => 1, 'status' => 'running']);

        $this->as(Role::Ppic)->get('/dashboard')->assertOk()->assertSee('Run #2');
        $this->get('/twin')->assertOk()->assertSee('data-run-id="2"', false);
        $this->get('/maps')->assertOk()->assertSee('Run #2');
        $this->get('/twin?run='.$first->id)->assertOk()->assertSee('data-run-id="1"', false);
        $this->get('/dashboard?run=3')->assertOk()->assertSee('Run #3')->assertSee('belum selesai');
        $this->get('/dashboard?run=99')->assertNotFound();
    }

    public function test_dashboard_has_chips_cards_and_todays_schedule(): void
    {
        $this->finishedRun(1);

        $this->as(Role::Ppic)->get('/dashboard')->assertOk()
            ->assertSee('Jadwal hari ini')->assertSee('Digital Twin')->assertSee('Maps')
            ->assertSee(route('twin', ['run' => 1]), false)->assertSee(route('maps', ['run' => 1]), false)
            ->assertSee('RT-001');
    }

    public function test_day_schedule_joins_dispatch_arrival_and_bay_per_truck(): void
    {
        $this->finishedRun(1);
        $rows = (new DaySchedule)->forRun(1);

        $this->assertCount($this->sample['kpi']['trucks'], $rows);
        $this->assertSame('RT-001', $rows[0]['code']);
        // Hari operasi 06:00-06:00: urutan menurut jam sejak 06:00 (jam 00:xx jatuh paling akhir).
        $etas = array_column($rows, 'eta');
        $sinceStart = fn (string $hm) => (((int) substr($hm, 0, 2)) * 60 + (int) substr($hm, 3, 2) + 1080) % 1440;
        $sorted = $etas;
        usort($sorted, fn ($a, $b) => $sinceStart($a) <=> $sinceStart($b));
        $this->assertSame($sorted, $etas);
        foreach ($rows as $r) {
            $this->assertNotNull($r['plate']);
            $this->assertNotNull($r['eta']);
            $this->assertNotNull($r['arrived']);
            $this->assertSame($r['eta'], $r['arrived']);
        }
        $this->assertContains('Selesai', array_column($rows, 'status'));
    }

    public function test_holding_alerts_list_lots_near_or_over_limit_from_asset_level_events(): void
    {
        $this->finishedRun(1);
        $level = fn (int $seq, string $at, string $asset, string $lot, string $since) => [
            'run_id' => 1, 'seq' => 9000 + $seq, 'type' => 'asset.level', 'sim_time' => $at,
            'payload' => json_encode(['type' => 'asset.level', 'asset_code' => $asset, 'level_ton' => 10, 'capacity_ton' => 50, 'lot' => $lot, 'since' => $since, 'fill_start' => null, 'hold_max_min' => 240, 'low' => false]),
        ];
        DB::table('sim_events')->insert([
            $level(1, '2025-01-01 10:00:00', 'ASEP-1', 'INT-0001', '2025-01-01 08:00:00'),
            $level(2, '2025-01-01 11:15:00', 'ASEP-1', 'INT-0001', '2025-01-01 08:00:00'),
            $level(3, '2025-01-01 12:30:00', 'ASEP-2', 'INT-0002', '2025-01-01 08:00:00'),
            $level(4, '2025-01-01 09:00:00', 'ASEP-3', 'INT-0003', '2025-01-01 08:30:00'),
        ]);

        $rows = (new HoldingAlerts)->forRun(1);

        $this->assertSame(['ASEP-2', 'ASEP-1'], array_column($rows, 'asset'));
        $this->assertSame(['over', 'near'], array_column($rows, 'state'));
        $this->assertSame(195, $rows[1]['age_min']);
        $this->as(Role::Ppic)->get('/dashboard')->assertOk()->assertSee('Holding time aseptic tank')->assertSee('melewati batas')->assertSee('INT-0002');
    }

    public function test_orders_card_lists_feasibility_and_causes_from_the_orders_event(): void
    {
        $this->finishedRun(1);
        DB::table('sim_events')->where('type', 'orders.evaluated')->delete(); // contoh run bawaan sudah memuatnya
        $this->as(Role::Ppic)->get('/dashboard')->assertOk()->assertSee('Order &amp; kelayakan', false)->assertSee('belum punya evaluasi order');

        $order = fn (string $id, string $sku, bool $ok) => [
            'order' => $id, 'sku' => $sku, 'ordered_ton' => 40, 'milk_needed_ton' => 36, 'milk_used_ton' => $ok ? 36 : 20,
            'fulfilled_ton' => $ok ? 40 : 22.2, 'shortfall_ton' => $ok ? 0 : 17.8, 'feasible' => $ok,
            'causes' => $ok ? [] : [['code' => 'gate', 'label' => 'Truk ditahan/ditolak di gerbang atau lab (G1/G2)', 'milk_ton' => 16]],
        ];
        DB::table('sim_events')->insert(['run_id' => 1, 'seq' => 99500, 'type' => 'orders.evaluated', 'sim_time' => '2025-01-01 20:00:00', 'payload' => json_encode([
            'type' => 'orders.evaluated', 'source' => 'manual', 'milk_use_full_pct' => 100, 'milk_use_flavour_pct' => 90,
            'orders' => [$order('ORD-1', 'UHT-CHOC-200', true), $order('ORD-2', 'UHT-FULL-1000', false)],
        ])]);

        $r = (new OrderFeasibility)->forRun(1);
        $this->assertSame(1, $r['met']);
        $this->assertNull((new OrderFeasibility)->forRun(2));
        $this->as(Role::Ppic)->get('/dashboard')->assertOk()->assertSee('1 dari 2 order dapat dipenuhi penuh')
            ->assertSee('Dapat dipenuhi')->assertSee('Tidak penuh')->assertSee('gerbang atau lab (G1/G2) (15.534 L susu)');
    }

    public function test_balance_card_converts_ton_to_litre_and_reports_balance_and_kpis(): void
    {
        $this->finishedRun(1);
        DB::table('sim_events')->whereIn('type', ['volume.balance', 'orders.evaluated'])->delete(); // contoh run bawaan sudah memuatnya
        $this->as(Role::Ppic)->get('/dashboard')->assertOk()->assertSee('Neraca volume &amp; KPI', false)->assertSee('belum punya neraca volume');
        $this->assertNull((new VolumeBalance)->forRun(1));

        DB::table('sim_events')->insert(['run_id' => 1, 'seq' => 99600, 'type' => 'volume.balance', 'sim_time' => '2025-01-01 20:00:00', 'payload' => json_encode([
            'type' => 'volume.balance', 'opening_stock_ton' => 10, 'received_ton' => 100, 'fg_ton' => 90, 'loss_ton' => 4.5,
            'qa_hold_ton' => 5, 'tank_end_ton' => 0.5, 'in_process_ton' => 0, 'not_received_ton' => 22.5,
        ])]);

        $b = (new VolumeBalance)->forRun(1);
        $this->assertSame(110.0, $b['in_total']);
        $this->assertSame(110.0, $b['out_total']);
        $this->assertTrue($b['balanced']);
        $this->as(Role::Ppic)->get('/dashboard')->assertOk()->assertSee('Neraca seimbang.')->assertSee('1 ton = 970,87 L')
            ->assertSee('87.379 L')->assertSee('21.845 L susu tidak diterima')->assertSee('Order terpenuhi penuh')->assertSee('Utilisasi aset');

        DB::table('sim_events')->where('type', 'volume.balance')->update(['payload' => json_encode(['received_ton' => 100, 'opening_stock_ton' => 0, 'fg_ton' => 50, 'loss_ton' => 1, 'qa_hold_ton' => 0, 'tank_end_ton' => 0, 'in_process_ton' => 0, 'not_received_ton' => 0])]);
        $this->assertFalse((new VolumeBalance)->forRun(1)['balanced']);
    }

    public function test_wear_card_lists_fouling_and_shelf_life_from_the_event(): void
    {
        $this->finishedRun(1);
        DB::table('sim_events')->where('type', 'fouling.expiry')->delete(); // contoh run bawaan sudah memuatnya
        $this->as(Role::Ppic)->get('/dashboard')->assertOk()->assertSee('Fouling &amp; umur simpan', false)->assertSee('belum punya data fouling');
        $this->assertNull((new WearReport)->forRun(1));

        $ste = fn (string $c, string $state, ?string $at) => ['asset_code' => $c, 'run_min' => 120, 'peak_min' => 340, 'cip_count' => 1, 'state' => $state, 'reached_at' => $at];
        DB::table('sim_events')->insert(['run_id' => 1, 'seq' => 99700, 'type' => 'fouling.expiry', 'sim_time' => '2025-01-01 20:00:00', 'payload' => json_encode([
            'type' => 'fouling.expiry',
            'fouling' => ['limit_min' => 300, 'sterilizers' => [$ste('STE-1', 'over', '2025-01-01T11:30:00Z'), $ste('STE-2', 'ok', null)]],
            'expiry' => ['shelf_life_days' => 180, 'dispatch_lead_days' => 30, 'min_remaining_pct' => 60, 'skus' => [
                ['sku' => 'UHT-FULL-1000', 'lots' => 3, 'volume_ton' => 55.5, 'produced_on' => '2025-01-01', 'expires_on' => '2025-06-30', 'remaining_pct' => 83.3, 'state' => 'ok'],
            ]],
        ])]);

        $w = (new WearReport)->forRun(1);
        $this->assertSame(1, $w['fouling']['flagged']);
        $this->assertSame('11:30', $w['fouling']['sterilizers'][0]['reached_clock']);
        $this->assertNull((new WearReport)->forRun(2));
        $this->as(Role::Ppic)->get('/dashboard')->assertOk()->assertSee('batas 300 menit')->assertSee('Melewati batas, CIP disarankan')
            ->assertSee('11:30 UTC')->assertSee('2025-06-30')->assertSee('83%')->assertSee('Memenuhi');
    }

    public function test_maps_page_has_canvas_inbound_list_and_handoff_links(): void
    {
        $this->finishedRun(1);

        $this->as(Role::Ppic)->get('/maps')->assertOk()
            ->assertSee('id="map"', false)->assertSee('id="m-rows"', false)->assertSee('Baru tiba di gerbang')
            ->assertSee('data-replay-url="'.route('runs.replay', 1).'"', false)
            ->assertSee('data-twin-url="'.route('twin', ['run' => 1]).'"', false)
            ->assertSee('id="tw-minimize"', false);
    }

    public function test_twin_shows_gate_stats_and_link_to_maps_and_dashboard_has_live_previews(): void
    {
        $this->finishedRun(1);

        $this->as(Role::Ppic)->get('/twin')->assertOk()
            ->assertSee('id="s-inbound"', false)->assertSee('id="s-detected"', false)
            ->assertSee(route('maps', ['run' => 1]), false);
        $this->get('/dashboard')->assertOk()
            ->assertSee('id="mini-twin"', false)->assertSee('id="mini-map"', false)
            ->assertSee('data-replay-url="'.route('runs.replay', 1).'"', false);

        SimRun::forceCreate(['id' => 3, 'kind' => 'live', 'seed' => 1, 'status' => 'running']);
        $this->get('/dashboard?run=3')->assertOk()->assertDontSee('id="mini-twin"', false);
    }

    public function test_twin_has_minimize_back_to_dashboard_and_roles_are_enforced(): void
    {
        $this->finishedRun(1);

        $this->as(Role::Ppic)->get('/twin')->assertOk()
            ->assertSee('id="tw-minimize"', false)->assertSee(route('dashboard', ['run' => 1]), false);
        $this->as(Role::Driver)->get('/twin')->assertForbidden();
        $this->get('/maps')->assertForbidden();
        $this->get('/runs')->assertForbidden();
        $this->as(Role::Ppic)->get('/runs')->assertOk()->assertSee('Run terbaru');
    }
}
