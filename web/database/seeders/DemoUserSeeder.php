<?php

namespace Database\Seeders;

use App\Enums\Role;
use App\Models\User;
use Illuminate\Database\Seeder;

class DemoUserSeeder extends Seeder
{
    public function run(): void
    {
        if (app()->isProduction()) {
            return;
        }

        foreach (Role::cases() as $role) {
            User::unguarded(fn () => User::updateOrCreate(
                ['email' => "{$role->value}@demo.test"],
                ['name' => $role->label(), 'role' => $role, 'password' => 'password'],
            ));
        }
    }
}
