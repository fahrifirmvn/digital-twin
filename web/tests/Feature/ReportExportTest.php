<?php

namespace Tests\Feature;

use App\Enums\Role;
use App\Models\SimRun;
use App\Models\User;
use App\Services\AuditLogger;
use Database\Seeders\MasterDataSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ReportExportTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        config(['services.engine.token' => 'secret']);
        $this->seed(MasterDataSeeder::class);
        SimRun::forceCreate(['id' => 1, 'kind' => 'live', 'seed' => 1, 'status' => 'running']);
        $result = json_decode(file_get_contents(base_path('../contracts/run-result.sample.json')), true, flags: JSON_THROW_ON_ERROR);
        $this->postJson('/internal/runs/1/result', $result, ['X-Internal-Token' => 'secret'])->assertOk();
    }

    private function as(Role $role): void
    {
        $this->actingAs(User::factory()->role($role)->create());
    }

    public function test_csv_report_is_downloadable_and_contains_run_kpis_and_truck_quality_data(): void
    {
        $this->as(Role::Ppic);
        $response = $this->get('/runs/1/report/csv')->assertOk()->assertDownload('lactatwin-run-1-report.csv');
        $csv = $response->streamedContent();
        $this->assertStringContainsString('Truk terjadwal', $csv);
        $this->assertStringContainsString('pH', $csv);
    }

    public function test_pdf_and_docx_reports_are_generated(): void
    {
        $this->as(Role::Ppic);
        $this->get('/runs/1/report/pdf')->assertOk()->assertDownload('lactatwin-run-1-report.pdf');

        $response = $this->get('/runs/1/report/docx')->assertOk()->assertDownload('lactatwin-run-1-report.docx');
        $path = $response->baseResponse->getFile()->getPathname();
        $this->assertStringStartsWith('PK', file_get_contents($path));
    }

    public function test_report_requires_full_twin_permission_and_completed_payload(): void
    {
        $this->as(Role::Driver);
        $this->get('/runs/1/report/csv')->assertForbidden();

        $this->as(Role::Ppic);
        $run = SimRun::forceCreate(['id' => 2, 'kind' => 'live', 'seed' => 1, 'status' => 'finished']);
        $this->assertNull($run->result_payload);
        $this->get('/runs/2/report/pdf')->assertNotFound();
    }

    public function test_csv_escapes_spreadsheet_formulas_and_records_export_audit(): void
    {
        $run = SimRun::findOrFail(1);
        $payload = $run->result_payload;
        $payload['gates'][] = ['gate' => 'G1', 'object_id' => 'RT-001', 'decision' => 'hold', 'reason' => '=1+1'];
        $run->forceFill(['result_payload' => $payload])->save();
        $this->as(Role::Ppic);
        $logged = [];
        $this->mock(AuditLogger::class, function ($mock) use (&$logged) {
            $mock->shouldReceive('record')->andReturnUsing(function ($type, $id, $action, $body) use (&$logged) {
                $logged[] = [$type, $id, $action, $body];
            });
        });

        $csv = $this->get('/runs/1/report/csv')->assertOk()->streamedContent();
        $this->assertStringContainsString("'=1+1", $csv);
        $this->assertSame('report.exported', $logged[0][2]);
        $this->assertSame(['run_id' => 1, 'format' => 'csv'], $logged[0][3]);
    }
}
