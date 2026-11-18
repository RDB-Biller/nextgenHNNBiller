<?php
/**
 * Dry Run connector for Laravel. Read-only.
 *
 * 1. Copy this file to app/Http/Middleware/DryRunMiddleware.php and the page script to public/dryrun/dryrun.js.
 * 2. Add to .env:   DRYRUN_TOKEN=...  DRYRUN_SECRET=...  DRYRUN_ORIGIN=https://your-dry-run-address
 * 3. Register it first (Laravel 11+, bootstrap/app.php):
 *        ->withMiddleware(function (Middleware $middleware) { $middleware->prepend(\App\Http\Middleware\DryRunMiddleware::class); })
 *    Laravel 10 and older: add \App\Http\Middleware\DryRunMiddleware::class at the top of $middleware in app/Http/Kernel.php.
 * 4. Add <script src="/dryrun/dryrun.js" data-dryrun-origin="https://your-dry-run-address" defer></script> to your layout.
 *
 * Optional config/dryrun.php: ['name' => 'My product', 'settings' => ['currency' => 'GHS'], 'forms' => [], 'api' => [],
 *   'permissions' => ['structure' => true, 'iterate' => true, 'sampleData' => false], 'apply_pack' => false]
 * It answers /.well-known/dryrun.json, /dryrun/capture (signed requests from Dry Run only) and, if apply_pack is on, /dryrun/pack.json.
 * Routes are read from your router. Values under keys that look secret are replaced with "[hidden]".
 */
namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

class DryRunMiddleware
{
    private function scrub($v, $d = 0)
    {
        if ($d > 5) return null;
        if (is_array($v)) {
            $o = []; $i = 0;
            foreach ($v as $k => $x) { if (++$i > 200) break; $o[$k] = (is_string($k) && preg_match('/pass(word)?|secret|token|api[_-]?key|authorization|cookie|private|credential|bearer|signature/i', $k)) ? '[hidden]' : $this->scrub($x, $d + 1); }
            return $o;
        }
        return is_string($v) ? substr($v, 0, 500) : $v;
    }

    private function cfg($key, $default = null)
    {
        return function_exists('config') ? config('dryrun.' . $key, $default) : $default;
    }

    private function json($body, $code = 200)
    {
        return response()->json($body, $code, ['Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff']);
    }

    private function routes()
    {
        $out = [];
        try {
            foreach (app('router')->getRoutes()->getRoutes() as $r) {
                $uri = '/' . ltrim($r->uri(), '/');
                if (preg_match('#^/(dryrun|\.well-known|_ignition|sanctum)#', $uri)) continue;
                foreach ($r->methods() as $m) { if ($m !== 'HEAD') $out[] = ['method' => $m, 'path' => $uri]; }
            }
        } catch (\Throwable $e) {}
        return array_slice($out, 0, 200);
    }

    public function handle(Request $request, Closure $next)
    {
        $token = env('DRYRUN_TOKEN', $this->cfg('token')); $secret = env('DRYRUN_SECRET', $this->cfg('secret'));
        if (!$token || !$secret) return $next($request);
        $origins = array_values(array_filter([env('DRYRUN_ORIGIN', $this->cfg('origin'))]));
        $perms = array_merge(['structure' => true, 'iterate' => true, 'sampleData' => false], $this->cfg('permissions', []) ?: []);
        $path = '/' . ltrim($request->path(), '/');
        if ($request->isMethod('GET') || $request->isMethod('HEAD')) {
            if ($path === '/.well-known/dryrun.json') return $this->json(['dryrun' => 1, 'token' => $token, 'capture' => '/dryrun/capture', 'overlay' => true, 'permissions' => $perms, 'allowedOrigins' => $origins]);
            if ($path === '/dryrun/pack.json') {
                $f = $this->cfg('pack_file', base_path('dryrun-pack.json'));
                if (($this->cfg('apply_pack', false) || env('DRYRUN_APPLY_PACK') === '1') && is_file($f)) return response(file_get_contents($f), 200, ['Content-Type' => 'application/json']);
                return $this->json(['error' => 'No pack is applied.'], 404);
            }
            if ($path === '/dryrun/capture') {
                $ts = $request->header('x-dryrun-ts', ''); $sig = (string) $request->header('x-dryrun-sig', '');
                $fresh = preg_match('/^\d{13}$/', $ts) && abs(microtime(true) * 1000 - (float) $ts) < 300000;
                $want = hash_hmac('sha256', $ts . '.GET./dryrun/capture', $secret);
                if (!$fresh || !hash_equals($want, $sig)) return $this->json(['error' => 'Not signed by Dry Run.'], 401);
                if (!$perms['structure']) return $this->json(['error' => 'Structure capture is not allowed.'], 403);
                $val = function ($x) { return is_callable($x) ? $x() : $x; };
                $body = ['dryrun' => 1, 'name' => $this->cfg('name', config('app.name', '')), 'framework' => 'Laravel ' . app()->version(), 'version' => $this->cfg('version', ''), 'routes' => $this->routes(),
                    'forms' => $this->scrub($val($this->cfg('forms', []))), 'api' => $this->scrub($val($this->cfg('api'))), 'settings' => (object) $this->scrub($val($this->cfg('settings', []))), 'flags' => (object) $this->scrub($val($this->cfg('flags', []))), 'permissions' => $perms];
                if ($perms['sampleData'] && $this->cfg('sample')) $body['sample'] = $this->scrub($val($this->cfg('sample')));
                return $this->json($body);
            }
        }
        $response = $next($request);
        if ($perms['iterate'] && $origins && !$response->headers->has('Content-Security-Policy')) $response->headers->set('Content-Security-Policy', "frame-ancestors 'self' " . implode(' ', $origins));
        return $response;
    }
}
