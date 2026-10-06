<?php

use Illuminate\Support\Facades\Route;
use Synloquent\Laravel\Http\ProtocolController;
use Synloquent\Laravel\Http\SnapshotDownloadController;
use Synloquent\Laravel\Http\SnapshotPartController;

Route::middleware(config('synloquent.middleware', ['api', 'auth']))->prefix(config('synloquent.route_prefix', 'synloquent/v1'))->group(function (): void {
    Route::post('/protocol', ProtocolController::class)->name('synloquent.protocol');
    Route::get('/snapshots/{generation}/{hash}', SnapshotDownloadController::class)->where(['generation' => '[a-f0-9]{64}', 'hash' => '[a-f0-9]{64}'])->name('synloquent.snapshot.download');
    Route::get('/snapshots/{generation}/{hash}/parts/{ordinal}', [SnapshotPartController::class, 'part'])->where(['generation' => '[a-f0-9]{64}', 'hash' => '[a-f0-9]{64}', 'ordinal' => '[0-9]+'])->name('synloquent.snapshot.part');
    Route::get('/snapshots/{generation}/{hash}/parts/{ordinal}/bundle', [SnapshotPartController::class, 'bundle'])->where(['generation' => '[a-f0-9]{64}', 'hash' => '[a-f0-9]{64}', 'ordinal' => '[0-9]+'])->name('synloquent.snapshot.bundle');
    Route::post('/snapshots/{generation}/{hash}/confirm', [SnapshotPartController::class, 'confirm'])->where(['generation' => '[a-f0-9]{64}', 'hash' => '[a-f0-9]{64}'])->name('synloquent.snapshot.confirm');
});
