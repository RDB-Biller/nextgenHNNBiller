"""Dry Run connector for Python (standard library only). WSGI middleware: works with Flask, Django, FastAPI (via a2wsgi) and others.

    from dryrun_connector import DryRun
    app.wsgi_app = DryRun(app.wsgi_app, name="My product", token=os.environ["DRYRUN_TOKEN"], secret=os.environ["DRYRUN_SECRET"],
                          origins=[os.environ["DRYRUN_ORIGIN"]], settings={"currency": "GHS"})

Read-only. Answers /.well-known/dryrun.json, /dryrun/dryrun.js (keep dryrun.js beside this file), /dryrun/capture (signed requests from
Dry Run only) and, if apply_pack is on, /dryrun/pack.json. Values under keys that look secret are replaced with "[hidden]".
"""
import hashlib, hmac, json, os, re, time

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


class DryRun:
    def __init__(self, app, token, secret, origins=(), name="", framework="Python", version="", settings=None, forms=None, api=None,
                 flags=None, routes=None, sample=None, permissions=None, apply_pack=False, pack_file="dryrun-pack.json"):
        if not token or not secret:
            raise ValueError("Dry Run connector: set token and secret (shown in the Dry Run Workroom, Sites).")
        self.app, self.token, self.secret = app, token, secret.encode()
        self.origins = [o for o in origins if o]
        self.o = dict(name=name, framework=framework, version=version, settings=settings, forms=forms, api=api, flags=flags, routes=routes, sample=sample)
        self.perms = {"structure": True, "iterate": True, "sampleData": False, **(permissions or {})}
        self.apply_pack, self.pack_file = apply_pack or os.environ.get("DRYRUN_APPLY_PACK") == "1", pack_file

    def _val(self, x):
        return x() if callable(x) else x

    def _send(self, start, code, body, ctype="application/json"):
        data = (body if isinstance(body, str) else json.dumps(body)).encode()
        start(f"{code} {'OK' if code == 200 else 'Error'}", [("Content-Type", ctype + "; charset=utf-8"), ("Cache-Control", "no-store"),
                                                             ("X-Content-Type-Options", "nosniff"), ("Content-Length", str(len(data)))])
        return [data]

    def __call__(self, environ, start):
        path, method = environ.get("PATH_INFO", ""), environ.get("REQUEST_METHOD", "GET")
        if method not in ("GET", "HEAD"):
            return self.app(environ, start)
        if path == "/.well-known/dryrun.json":
            return self._send(start, 200, {"dryrun": 1, "token": self.token, "capture": "/dryrun/capture", "overlay": True, "permissions": self.perms, "allowedOrigins": self.origins})
        if path == "/dryrun/dryrun.js":
            try:
                with open(os.path.join(os.path.dirname(__file__), "dryrun.js"), encoding="utf8") as f:
                    return self._send(start, 200, f.read(), "application/javascript")
            except OSError:
                return self._send(start, 404, {"error": "Put dryrun.js beside dryrun_connector.py."})
        if path == "/dryrun/pack.json":
            try:
                if not self.apply_pack:
                    raise OSError
                with open(self.pack_file, encoding="utf8") as f:
                    return self._send(start, 200, f.read())
            except OSError:
                return self._send(start, 404, {"error": "No pack is applied."})
        if path == "/dryrun/capture":
            ts, sig = environ.get("HTTP_X_DRYRUN_TS", ""), environ.get("HTTP_X_DRYRUN_SIG", "")
            fresh = re.fullmatch(r"\d{13}", ts) and abs(time.time() * 1000 - int(ts)) < 300000
            want = hmac.new(self.secret, f"{ts}.GET./dryrun/capture".encode(), hashlib.sha256).hexdigest()
            if not fresh or not hmac.compare_digest(sig, want):
                return self._send(start, 401, {"error": "Not signed by Dry Run."})
            if not self.perms["structure"]:
                return self._send(start, 403, {"error": "Structure capture is not allowed."})
            o = self.o
            body = {"dryrun": 1, "name": o["name"], "framework": o["framework"], "version": o["version"], "routes": self._val(o["routes"]) or [],
                    "forms": _scrub(self._val(o["forms"])) or [], "api": _scrub(self._val(o["api"])), "settings": _scrub(self._val(o["settings"])) or {},
                    "flags": _scrub(self._val(o["flags"])) or {}, "permissions": self.perms}
            if self.perms["sampleData"] and o["sample"]:
                body["sample"] = _scrub(self._val(o["sample"]))
            return self._send(start, 200, body)
        if self.perms["iterate"] and self.origins:
            def sr(status, headers, *a):
                if not any(k.lower() == "content-security-policy" for k, _ in headers):
                    headers = list(headers) + [("Content-Security-Policy", "frame-ancestors 'self' " + " ".join(self.origins))]
                return start(status, headers, *a)
            return self.app(environ, sr)
        return self.app(environ, start)
