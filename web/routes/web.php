<?php

use App\Http\Controllers\AuditController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\FieldController;
use App\Http\Controllers\LayoutController;
use App\Http\Controllers\RunController;
use App\Http\Controllers\ScheduleApprovalController;
use App\Http\Controllers\SimulationController;
use App\Http\Controllers\TraceController;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Route;

Route::middleware('guest')->group(function () {
    Route::get('/login', [AuthController::class, 'showLogin'])->name('login');
    Route::post('/login', [AuthController::class, 'login'])->middleware('throttle:5,1');
});

Route::middleware('auth')->group(function () {
    Route::post('/logout', [AuthController::class, 'logout'])->name('logout');

    // Layar penuh Twin untuk yang boleh melihatnya; sopir dan lainnya ke Dashboard terbatas.
    Route::get('/', fn () => redirect()->route(Gate::allows('view-twin-full') ? 'twin' : 'dashboard'));

    Route::get('/dashboard', [RunController::class, 'home'])->middleware('can:view-twin')->name('dashboard');

    Route::post('/runs', [RunController::class, 'store'])->middleware('can:run-scenario')->name('runs.store');
    Route::post('/runs/{run}/retest', [RunController::class, 'retest'])
        ->middleware(['can:run-scenario', 'throttle:6,1'])->whereNumber('run')->name('runs.retest');
    Route::post('/runs/{run}/fork', [SimulationController::class, 'fork'])
        ->middleware(['can:simulate', 'throttle:10,1'])->whereNumber('run')->name('runs.fork');
    Route::middleware('can:view-twin-full')->group(function () {
        Route::get('/twin', [RunController::class, 'twinCurrent'])->name('twin');
        Route::get('/maps', [RunController::class, 'maps'])->name('maps');
        Route::get('/runs', [RunController::class, 'index'])->name('runs.index');
        Route::get('/runs/{run}', [RunController::class, 'show'])->name('runs.show');
        Route::get('/runs/{run}/twin', [RunController::class, 'twin'])->name('runs.twin');
        Route::get('/runs/{run}/replay', [RunController::class, 'replay'])->name('runs.replay');
    });

    // Mode membangun: atur jumlah modul pabrik, simpan denah, lalu jalankan sebagai run baru.
    Route::middleware('can:build-layout')->group(function () {
        Route::get('/twin/build', [LayoutController::class, 'build'])->name('build');
        Route::post('/layouts', [LayoutController::class, 'store'])->middleware('throttle:20,1')->name('layouts.store');
        Route::delete('/layouts/{layout}', [LayoutController::class, 'destroy'])->whereNumber('layout')->name('layouts.destroy');
    });

    Route::post('/runs/{run}/versions/{version}/approve', [ScheduleApprovalController::class, 'approve'])
        ->middleware('can:approve-schedule')->whereNumber(['run', 'version'])->name('schedule.approve');

    Route::middleware('can:check-in-truck')->group(function () {
        Route::get('/driver', [FieldController::class, 'page'])->defaults('mode', 'driver')->name('driver');
        Route::get('/field/manifest', [FieldController::class, 'manifest'])->name('field.manifest');
        Route::post('/field/confirmations', [FieldController::class, 'store'])->middleware('throttle:60,1')->name('field.confirm');
    });
    Route::get('/operator', [FieldController::class, 'page'])->defaults('mode', 'operator')
        ->middleware('can:confirm-handoff')->name('operator');

    Route::get('/trace', [TraceController::class, 'index'])->middleware('can:view-trace')->name('trace');

    Route::middleware('can:view-audit-log')->group(function () {
        Route::get('/audit', [AuditController::class, 'index'])->name('audit');
        Route::post('/audit/verify', [AuditController::class, 'verify'])->name('audit.verify');
    });
});
