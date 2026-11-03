<?php

namespace App\Http\Controllers;

use App\Services\AuditLogger;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

// Approval Modal (PRD 10.6, pagar 2): satu-satunya jalur yang mengaktifkan versi jadwal.
// LLM hanya mengusulkan; PPIC menyetujui dengan alasan, dan keputusan masuk audit log.
class ScheduleApprovalController extends Controller
{
    public function approve(Request $request, int $run, int $version, AuditLogger $audit)
    {
        $data = $request->validate(['reason' => ['required', 'string', 'min:5', 'max:500']]);
        $user = $request->user();

        $result = DB::transaction(function () use ($run, $version, $data, $user) {
            $target = DB::table('schedule_versions')
                ->join('schedules', 'schedules.id', '=', 'schedule_versions.schedule_id')
                ->where('schedules.run_id', $run)->where('schedule_versions.version', $version)
                ->lockForUpdate()
                ->first(['schedule_versions.id', 'schedule_versions.schedule_id', 'schedule_versions.status']);
            abort_if($target === null, 404);
            abort_unless(in_array($target->status, ['proposed', 'superseded'], true), 422, 'Versi ini tidak dapat disetujui.');

            $previous = DB::table('schedule_versions')
                ->where('schedule_id', $target->schedule_id)->where('status', 'active')->pluck('version')->all();
            DB::table('schedule_versions')->whereIn('version', $previous)->where('schedule_id', $target->schedule_id)
                ->update(['status' => 'superseded', 'updated_at' => now()]);
            DB::table('schedule_versions')->where('id', $target->id)->update([
                'status' => 'active',
                'approved_by' => $user->id,
                'approval_reason' => $data['reason'],
                'approved_at' => now(),
                'updated_at' => now(),
            ]);

            return ['previous_active' => $previous];
        });

        $audit->record('user', (string) $user->id, 'schedule.approved', [
            'run_id' => $run, 'version' => $version, 'reason' => $data['reason'],
        ] + $result);

        return back()->with('status', "Versi v{$version} disetujui dan diaktifkan.");
    }
}
