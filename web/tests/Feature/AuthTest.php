<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class AuthTest extends TestCase
{
    use RefreshDatabase;

    public function test_guest_is_redirected_to_login(): void
    {
        $this->get('/dashboard')->assertRedirect('/login');
    }

    public function test_user_can_log_in(): void
    {
        $user = User::factory()->role(Role::Ppic)->create(['email' => 'ppic@demo.test']);

        $this->post('/login', ['email' => 'ppic@demo.test', 'password' => 'password'])
            ->assertRedirect('/');
        $this->assertAuthenticatedAs($user);
    }

    public function test_wrong_password_is_rejected(): void
    {
        User::factory()->create(['email' => 'x@demo.test']);

        $this->post('/login', ['email' => 'x@demo.test', 'password' => 'nope'])
            ->assertSessionHasErrors('email');
        $this->assertGuest();
    }

    public function test_role_is_not_mass_assignable(): void
    {
        $user = User::create(['name' => 'a', 'email' => 'a@demo.test', 'password' => 'x', 'role' => 'admin']);

        $this->assertSame(Role::Observer, $user->fresh()->role);
    }
}
