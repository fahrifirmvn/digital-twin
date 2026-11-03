<?php

use App\Http\Controllers\RunResultController;
use App\Http\Controllers\TwinEventController;
use Illuminate\Support\Facades\Route;

// Prefiks /internal. Hanya untuk Engine, dijaga token bersama.
Route::middleware('internal')->group(function () {
    Route::post('/twin-events', [TwinEventController::class, 'store']);
    Route::post('/runs/{run}/result', [RunResultController::class, 'store']);
});
