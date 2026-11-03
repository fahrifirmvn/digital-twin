<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Gate;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

// Matriks izin PRD bagian 4 (kolom manusia).
class AbilitiesTest extends TestCase
{
    use RefreshDatabase;

    public static function matrix(): array
    {
        return [
            'view-twin' => ['view-twin', [Role::Ppic, Role::Qa, Role::Operator, Role::Driver, Role::Admin, Role::Observer]],
            'run-scenario' => ['run-scenario', [Role::Ppic, Role::Admin]],
            'simulate' => ['simulate', [Role::Ppic, Role::Admin, Role::Observer]],
            'intervene' => ['intervene', [Role::Ppic, Role::Admin]],
            'propose-schedule' => ['propose-schedule', [Role::Ppic]],
            'approve-schedule' => ['approve-schedule', [Role::Ppic]],
            'decide-quality-gate' => ['decide-quality-gate', [Role::Qa]],
            'propose-threshold' => ['propose-threshold', [Role::Qa]],
            'change-threshold' => ['change-threshold', [Role::Admin]],
            'check-in-truck' => ['check-in-truck', [Role::Operator, Role::Driver]],
            'confirm-handoff' => ['confirm-handoff', [Role::Operator]],
            'view-audit-log' => ['view-audit-log', [Role::Ppic, Role::Qa, Role::Admin]],
        ];
    }

    #[DataProvider('matrix')]
    public function test_ability_is_granted_only_to_allowed_roles(string $ability, array $allowed): void
    {
        foreach (Role::cases() as $role) {
            $user = User::factory()->role($role)->make();

            $this->assertSame(
                in_array($role, $allowed, true),
                Gate::forUser($user)->allows($ability),
                "{$role->value} / {$ability}",
            );
        }
    }

    public function test_operator_cannot_open_audit_page(): void
    {
        $this->actingAs(User::factory()->role(Role::Operator)->create())->get('/audit')->assertForbidden();
    }
}
