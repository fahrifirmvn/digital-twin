<?php

namespace App\Http\Controllers;

use App\Services\OperationService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

// Operasi harian: status, riwayat hari yang sudah lewat (untuk putar ulang), dan maju ke hari berikutnya.
class OperationController extends Controller
{
    public function state(OperationService $op): JsonResponse
    {
        return response()->json($op->state());
    }

    public function advance(Request $request, OperationService $op): JsonResponse
    {
        return response()->json($op->advance($request->user()));
    }
}
