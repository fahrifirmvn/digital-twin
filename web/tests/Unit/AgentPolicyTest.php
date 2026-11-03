<?php

namespace Tests\Unit;

use App\Services\AgentPolicy;
use PHPUnit\Framework\TestCase;

class AgentPolicyTest extends TestCase
{
    private function waiting(): array
    {
        return [['code' => 'TK-002', 'since' => 430.0], ['code' => 'TK-001', 'since' => 430.0], ['code' => 'TK-003', 'since' => 410.0]];
    }

    public function test_level_zero_proposes_nothing(): void
    {
        $this->assertSame([], AgentPolicy::candidates(0, 6, $this->waiting(), [], [], 60));
    }

    public function test_level_one_and_two_only_approve_waiting_plans_in_waiting_order(): void
    {
        foreach ([1, 2] as $level) {
            $out = AgentPolicy::candidates($level, 6, $this->waiting(), [['code' => 'TK-009', 'eta' => 500.0]], [[480.0, 720.0]], 60);
            $this->assertSame(['TK-003', 'TK-001', 'TK-002'], array_map(fn ($c) => $c['args']['truck'], $out));
            $this->assertSame(['plan_approve'], array_values(array_unique(array_column($out, 'kind'))));
        }
    }

    public function test_level_three_holds_only_inbound_trucks_arriving_inside_an_outage(): void
    {
        $inbound = [['code' => 'TK-009', 'eta' => 500.0], ['code' => 'TK-008', 'eta' => 900.0], ['code' => 'TK-007', 'eta' => 481.0]];
        $out = AgentPolicy::candidates(3, 6, [], $inbound, [[480.0, 720.0]], 45);

        $this->assertSame([['kind' => 'truck_hold', 'args' => ['truck' => 'TK-007', 'duration_min' => 45]], ['kind' => 'truck_hold', 'args' => ['truck' => 'TK-009', 'duration_min' => 45]]],
            array_map(fn ($c) => ['kind' => $c['kind'], 'args' => $c['args']], $out));
    }

    public function test_limit_caps_the_command_count(): void
    {
        $this->assertCount(2, AgentPolicy::candidates(3, 2, $this->waiting(), [], [], 60));
        $this->assertSame([], AgentPolicy::candidates(3, 0, $this->waiting(), [], [], 60));
    }

    public function test_policy_never_emits_gate_quality_or_release_kinds(): void
    {
        $out = AgentPolicy::candidates(3, 20, $this->waiting(), [['code' => 'TK-009', 'eta' => 500.0]], [[0.0, 1440.0]], 60);
        foreach ($out as $c) {
            $this->assertContains($c['kind'], AgentPolicy::KINDS);
        }
        $this->assertNotContains('truck_release', AgentPolicy::KINDS);
        $this->assertNotContains('plan_change', AgentPolicy::KINDS);
    }

    public function test_verdict_passes_when_not_worse_and_no_gate_attempt(): void
    {
        $v = AgentPolicy::verdict(['truck_wait_min' => ['mean' => 20.04]], ['truck_wait_min' => ['mean' => 22]], []);
        $this->assertSame(['verdict' => 'lulus', 'mean' => 20.0, 'base' => 22.0, 'delta' => -2.0, 'violations' => 0], $v);
        $this->assertSame('lulus', AgentPolicy::verdict(['truck_wait_min' => ['mean' => 22]], ['truck_wait_min' => ['mean' => 22]], [])['verdict']);
    }

    public function test_verdict_fails_on_gate_attempt_even_if_faster_and_is_not_better_when_slower(): void
    {
        $fast = ['truck_wait_min' => ['mean' => 10]];
        $slow = ['truck_wait_min' => ['mean' => 30]];
        $base = ['truck_wait_min' => ['mean' => 20]];
        $this->assertSame('gagal', AgentPolicy::verdict($fast, $base, [['blocked' => true, 'gate' => 'G1']])['verdict']);
        $this->assertSame('lulus', AgentPolicy::verdict($fast, $base, [['blocked' => true, 'gate' => null]])['verdict']);
        $this->assertSame('belum', AgentPolicy::verdict($slow, $base, [])['verdict']);
        $this->assertSame('tanpa_data', AgentPolicy::verdict(null, $base, [])['verdict']);
    }
}
