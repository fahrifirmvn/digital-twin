<?php

namespace App\Support;

use App\Enums\Role;

// Matriks izin PRD bagian 4. Sumber tunggal untuk Gate dan middleware.
final class Abilities
{
    /** @return array<string, list<Role>> */
    public static function matrix(): array
    {
        return [
            'view-twin' => [Role::Ppic, Role::Qa, Role::Operator, Role::Driver, Role::Admin, Role::Observer],
            'view-twin-full' => [Role::Ppic, Role::Qa, Role::Operator, Role::Admin, Role::Observer],
            'run-scenario' => [Role::Ppic, Role::Admin],
            // Mode Simulasi: cabang what-if dari run yang sudah selesai; tidak mengubah jadwal nyata.
            'simulate' => [Role::Ppic, Role::Admin, Role::Observer],
            // Intervensi PPIC pada cabang simulasi: setujui/ubah/tolak usulan, tahan/lepas truk. Gate SOP tetap tidak bisa dilewati.
            'intervene' => [Role::Ppic, Role::Admin],
            // Mode membangun: mengubah jumlah modul pabrik dan menyimpan denah; hasilnya selalu run baru.
            'build-layout' => [Role::Ppic, Role::Admin],
            // Kampanye harian: buat, mulai hari, jadwalkan maintenance, pulihkan cabang. Semuanya sandbox SIMULASI.
            'manage-campaign' => [Role::Ppic, Role::Admin],
            // Usulan Operator Agent: hanya PPIC/Admin yang dapat menyetujui atau menolak (dengan alasan). Pembuat usulan bukan syarat.
            'approve-proposal' => [Role::Ppic, Role::Admin],
            'propose-schedule' => [Role::Ppic],
            'approve-schedule' => [Role::Ppic],
            'decide-quality-gate' => [Role::Qa],
            'review-live-qa' => [Role::Qa, Role::Admin],
            'propose-threshold' => [Role::Qa],
            'change-threshold' => [Role::Admin],
            'check-in-truck' => [Role::Operator, Role::Driver],
            'confirm-handoff' => [Role::Operator],
            'view-trace' => [Role::Ppic, Role::Qa, Role::Admin],
            'view-audit-log' => [Role::Ppic, Role::Qa, Role::Admin],
        ];
    }
}
