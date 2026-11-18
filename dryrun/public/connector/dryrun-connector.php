<?php
/**
 * Dry Run connector for PHP (no dependencies). Read-only.
 * At the very top of your index.php (or a front controller), before any output:
 *
 *   require __DIR__ . '/dryrun-connector.php';
 *   dryrun_connector([
 *     'name' => 'My product', 'token' => getenv('DRYRUN_TOKEN'), 'secret' => getenv('DRYRUN_SECRET'),
 *     'origins' => [getenv('DRYRUN_ORIGIN')], 'settings' => ['currency' => 'GHS'],
 *   ]);
 *
 * It answers /.well-known/dryrun.json, /dryrun/dryrun.js (keep dryrun.js beside this file), /dryrun/capture (signed requests from
 * Dry Run only) and, with 'applyPack' => true, /dryrun/pack.json. Everything else carries on as normal.
 * Values under keys that look secret are replaced with "[hidden]".
 */
function dryrun_scrub($v, $d = 0) {
  if ($d > 5) return null;
  if (is_array($v)) { $o = []; $i = 0; foreach ($v as $k => $x) { if (++$i > 200) break; $o[$k] = (is_string($k) && preg_match('/pass(word)?|secret|token|api[_-]?key|authorization|cookie|private|credential|bearer|signature/i', $k)) ? '[hidden]' : dryrun_scrub($x, $d + 1); } return $o; }
  if (is_string($v)) return substr($v, 0, 500);
  return $v;
}
function dryrun_send($code, $body, $type = 'application/json') {
  http_response_code($code); header('Content-Type: ' . $type . '; charset=utf-8'); header('Cache-Control: no-store'); header('X-Content-Type-Options: nosniff');
  echo is_string($body) ? $body : json_encode($body, JSON_UNESCAPED_SLASHES); exit;
}
function dryrun_connector($o) {
  $token = $o['token'] ?? ''; $secret = $o['secret'] ?? ''; if (!$token || !$secret) { throw new Exception('Dry Run connector: set token and secret (shown in the Dry Run Workroom, Sites).'); }
  $perms = array_merge(['structure' => true, 'iterate' => true, 'sampleData' => false], $o['permissions'] ?? []); $origins = array_values(array_filter($o['origins'] ?? []));
  if ($perms['iterate'] && $origins) { header("Content-Security-Policy: frame-ancestors 'self' " . implode(' ', $origins)); }
  if (!in_array($_SERVER['REQUEST_METHOD'] ?? 'GET', ['GET', 'HEAD'], true)) return;
  $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
  $val = function ($x) { return is_callable($x) ? $x() : $x; };
  if ($path === '/.well-known/dryrun.json') dryrun_send(200, ['dryrun' => 1, 'token' => $token, 'capture' => '/dryrun/capture', 'overlay' => true, 'permissions' => $perms, 'allowedOrigins' => $origins]);
  if ($path === '/dryrun/dryrun.js') { $f = __DIR__ . '/dryrun.js'; if (is_file($f)) dryrun_send(200, file_get_contents($f), 'application/javascript'); dryrun_send(404, ['error' => 'Put dryrun.js beside dryrun-connector.php.']); }
  if ($path === '/dryrun/pack.json') { $f = $o['packFile'] ?? (getcwd() . '/dryrun-pack.json'); if ((!empty($o['applyPack']) || getenv('DRYRUN_APPLY_PACK') === '1') && is_file($f)) dryrun_send(200, file_get_contents($f)); dryrun_send(404, ['error' => 'No pack is applied.']); }
  if ($path === '/dryrun/capture') {
    $ts = $_SERVER['HTTP_X_DRYRUN_TS'] ?? ''; $sig = $_SERVER['HTTP_X_DRYRUN_SIG'] ?? '';
    $fresh = preg_match('/^\d{13}$/', $ts) && abs(microtime(true) * 1000 - (float)$ts) < 300000; $want = hash_hmac('sha256', $ts . '.GET./dryrun/capture', $secret);
    if (!$fresh || !hash_equals($want, $sig)) dryrun_send(401, ['error' => 'Not signed by Dry Run.']);
    if (!$perms['structure']) dryrun_send(403, ['error' => 'Structure capture is not allowed.']);
    $body = ['dryrun' => 1, 'name' => $o['name'] ?? '', 'framework' => $o['framework'] ?? 'PHP', 'version' => $o['version'] ?? '', 'routes' => $val($o['routes'] ?? []), 'forms' => dryrun_scrub($val($o['forms'] ?? [])), 'api' => dryrun_scrub($val($o['api'] ?? null)), 'settings' => (object)dryrun_scrub($val($o['settings'] ?? [])), 'flags' => (object)dryrun_scrub($val($o['flags'] ?? [])), 'permissions' => $perms];
    if ($perms['sampleData'] && !empty($o['sample'])) $body['sample'] = dryrun_scrub($val($o['sample']));
    dryrun_send(200, $body);
  }
}
