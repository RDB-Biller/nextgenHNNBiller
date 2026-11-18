"""Dry Run connector for Django (standard library plus Django). Read-only.

1. Save dryrun_django.py and dryrun.js side by side (for example in your project root, next to manage.py).
2. In settings.py:

    MIDDLEWARE = ["dryrun_django.DryRunMiddleware", *MIDDLEWARE]    # first, so it answers before login checks
    DRYRUN = {
        "token": os.environ["DRYRUN_TOKEN"], "secret": os.environ["DRYRUN_SECRET"], "origins": [os.environ["DRYRUN_ORIGIN"]],
        "name": "My product",
        "settings": {"currency": "GHS"},        # non-secret settings you want Dry Run to see
        # "permissions": {"structure": True, "iterate": True, "sampleData": False},
        # "apply_pack": True,                   # serve an approved dryrun-pack.json to the page script
    }

3. Add <script src="/dryrun/dryrun.js" data-dryrun-origin="https://your-dry-run-address" defer></script> to your base template.

It answers /.well-known/dryrun.json, /dryrun/dryrun.js, /dryrun/capture (signed requests from Dry Run only) and, if apply_pack is on,
/dryrun/pack.json. Routes are read from your URL configuration. Values under keys that look secret are replaced with "[hidden]".
"""
import hashlib, hmac, json, os, re, time

from django.conf import settings as dj_settings
from django.http import HttpResponse

_SECRETISH = re.compile(r"pass(word)?|secret|token|api[_-]?key|authorization|cookie|private|credential|bearer|signature", re.I)


def _scrub(v, d=0):
    if d > 5:
        return None
    if isinstance(v, (list, tuple)):
        return [_scrub(x, d + 1) for x in list(v)[:200]]
    if isinstance(v, dict):
        return {str(k): ("[hidden]" if _SECRETISH.search(str(k)) else _scrub(x, d + 1)) for k, x in list(v.items())[:100]}
    if isinstance(v, str):
        return v[:500]
    return v


def _routes():
    out = []
    try:
        from django.urls import URLPattern, URLResolver, get_resolver

        def walk(patterns, prefix):
            for p in patterns:
                part = prefix + str(p.pattern)
                if isinstance(p, URLResolver):
                    walk(p.url_patterns, part)
                elif isinstance(p, URLPattern):
                    path = "/" + re.sub(r"[\^\$]|\(\?P<(\w+)>[^)]*\)", lambda m: "{" + m.group(1) + "}" if m.group(1) else "", part).lstrip("/")
                    out.append({"method": "ANY", "path": path})

        walk(get_resolver().url_patterns, "")
    except Exception:
        pass
    return [r for r in out if not r["path"].startswith(("/dryrun", "/.well-known"))][:200]


class DryRunMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response
        c = getattr(dj_settings, "DRYRUN", {})
        self.token, self.secret = c.get("token"), (c.get("secret") or "").encode()
        if not self.token or not self.secret:
            raise ValueError("Dry Run connector: set DRYRUN token and secret (shown in the Dry Run Workroom, Sites).")
        self.c = c
        self.origins = [o for o in c.get("origins", []) if o]
        self.perms = {"structure": True, "iterate": True, "sampleData": False, **c.get("permissions", {})}

    def _json(self, code, body):
        r = HttpResponse(json.dumps(body), status=code, content_type="application/json; charset=utf-8")
        r["Cache-Control"] = "no-store"
        r["X-Content-Type-Options"] = "nosniff"
        return r

    def _val(self, x):
        return x() if callable(x) else x

    def __call__(self, request):
        path = request.path_info
        if request.method in ("GET", "HEAD"):
            if path == "/.well-known/dryrun.json":
                return self._json(200, {"dryrun": 1, "token": self.token, "capture": "/dryrun/capture", "overlay": True, "permissions": self.perms, "allowedOrigins": self.origins})
            if path == "/dryrun/dryrun.js":
                try:
                    with open(os.path.join(os.path.dirname(__file__), "dryrun.js"), encoding="utf8") as f:
                        r = HttpResponse(f.read(), content_type="application/javascript; charset=utf-8")
                        r["Cache-Control"] = "no-store"
                        return r
                except OSError:
                    return self._json(404, {"error": "Put dryrun.js beside dryrun_django.py."})
            if path == "/dryrun/pack.json":
                try:
                    if not (self.c.get("apply_pack") or os.environ.get("DRYRUN_APPLY_PACK") == "1"):
                        raise OSError
                    with open(self.c.get("pack_file", "dryrun-pack.json"), encoding="utf8") as f:
                        return HttpResponse(f.read(), content_type="application/json; charset=utf-8")
                except OSError:
                    return self._json(404, {"error": "No pack is applied."})
            if path == "/dryrun/capture":
                ts, sig = request.META.get("HTTP_X_DRYRUN_TS", ""), request.META.get("HTTP_X_DRYRUN_SIG", "")
                fresh = re.fullmatch(r"\d{13}", ts) and abs(time.time() * 1000 - int(ts)) < 300000
                want = hmac.new(self.secret, f"{ts}.GET./dryrun/capture".encode(), hashlib.sha256).hexdigest()
                if not fresh or not hmac.compare_digest(sig, want):
                    return self._json(401, {"error": "Not signed by Dry Run."})
                if not self.perms["structure"]:
                    return self._json(403, {"error": "Structure capture is not allowed."})
                c = self.c
                body = {"dryrun": 1, "name": c.get("name", ""), "framework": "Django", "version": c.get("version", ""), "routes": self._val(c.get("routes")) or _routes(),
                        "forms": _scrub(self._val(c.get("forms"))) or [], "api": _scrub(self._val(c.get("api"))), "settings": _scrub(self._val(c.get("settings"))) or {},
                        "flags": _scrub(self._val(c.get("flags"))) or {}, "permissions": self.perms}
                if self.perms["sampleData"] and c.get("sample"):
                    body["sample"] = _scrub(self._val(c["sample"]))
                return self._json(200, body)
        response = self.get_response(request)
        if self.perms["iterate"] and self.origins and not response.has_header("Content-Security-Policy"):
            response["Content-Security-Policy"] = "frame-ancestors 'self' " + " ".join(self.origins)
        return response
