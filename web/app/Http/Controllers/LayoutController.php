<?php

namespace App\Http\Controllers;

use App\Models\Layout;
use App\Models\User;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

// Mode membangun (P7a): atur jumlah modul pabrik, lihat denah 3D, simpan, lalu jalankan sebagai run baru.
class LayoutController extends Controller
{
    public function build(Request $request)
    {
        return view('build', [
            'layouts' => Layout::query()->orderBy('name')->get()->map(fn (Layout $l) => $this->present($l, $request->user()))->values(),
            'plantFields' => array_keys(config('twin.plant.limits')),
        ]);
    }

    public function store(Request $request, AuditLogger $audit): JsonResponse
    {
        $rules = ['name' => ['required', 'string', 'min:3', 'max:60']];
        foreach (config('twin.plant.limits') as $field => [$min, $max]) {
            $rules["plant.$field"] = ['required', 'integer', "min:$min", "max:$max"];
        }
        $data = $request->validate($rules);

        $layout = Layout::create([
            'name' => trim($data['name']),
            'user_id' => $request->user()->id,
            'spec' => ['version' => 1, 'plant' => array_map('intval', $data['plant'])],
        ]);
        $audit->record('user', (string) $request->user()->id, 'layout.saved', ['layout_id' => $layout->id, 'name' => $layout->name] + $layout->plant());

        return response()->json($this->present($layout, $request->user()), 201);
    }

    public function destroy(Request $request, Layout $layout, AuditLogger $audit): JsonResponse
    {
        $user = $request->user();
        abort_unless($this->owns($layout, $user), 403, 'Hanya pemilik atau admin yang boleh menghapus denah.');
        $layout->delete();
        $audit->record('user', (string) $user->id, 'layout.deleted', ['layout_id' => $layout->id, 'name' => $layout->name]);

        return response()->json(['deleted' => true]);
    }

    private function owns(Layout $layout, User $user): bool
    {
        return $layout->user_id === $user->id || $user->role->value === 'admin';
    }

    /** @return array<string,mixed> */
    private function present(Layout $layout, User $user): array
    {
        return [
            'id' => $layout->id, 'name' => Str::limit($layout->name, 60, ''), 'plant' => $layout->plant(),
            'by' => $layout->owner?->name, 'can_delete' => $this->owns($layout, $user),
        ];
    }
}
