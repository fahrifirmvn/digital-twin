<?php

namespace App\Http\Controllers;

use App\Services\AuditLogger;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

class AuditController extends Controller
{
    public function index()
    {
        // Tabel hanya ada di PostgreSQL; di dev sqlite halaman tetap terbuka dengan daftar kosong.
        $ready = Schema::hasTable('audit_logs');

        return view('audit', [
            'ready' => $ready,
            'logs' => $ready ? DB::table('audit_logs')->orderByDesc('id')->limit(100)->get() : collect(),
        ]);
    }

    public function verify(Request $request, AuditLogger $audit)
    {
        $brokenId = $audit->firstBrokenId();
        $audit->record('user', (string) $request->user()->id, 'audit.verified', ['first_broken_id' => $brokenId]);

        return back()->with('verification', $brokenId === null
            ? 'Rantai utuh: seluruh hash cocok.'
            : "Rantai rusak. Baris pertama yang tidak cocok: #{$brokenId}.");
    }
}
