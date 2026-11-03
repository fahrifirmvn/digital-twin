<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

// Autentikasi panggilan Engine -> Laravel di jaringan internal.
class VerifyInternalToken
{
    public function handle(Request $request, Closure $next): Response
    {
        $expected = (string) config('services.engine.token');
        $given = (string) $request->header('X-Internal-Token');

        // Token kosong berarti belum dikonfigurasi, jadi tolak semua.
        if ($expected === '' || ! hash_equals($expected, $given)) {
            abort(401, 'invalid internal token');
        }

        return $next($request);
    }
}
