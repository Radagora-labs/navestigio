#!/usr/bin/env python3
"""Genera app/navestigio.html a partir de src/navestigio.template.html y de vendor/.

navestigio.html es un solo archivo (funciona con doble clic y sin internet), así que incrusta
sql.js (JavaScript + WebAssembly) y las fuentes. Este script permite a cualquiera comprobar
que el archivo publicado se construyó con los componentes oficiales:

    python build.py                 # verifica vendor/SHA256SUMS y genera app/navestigio.html
    python build.py --verificar-npm # además descarga sql.js de npm y compara byte a byte
    python build.py --zip           # además arma dist/navestigio-<versión>.zip para el release

Solo usa la biblioteca estándar de Python 3.8+.
"""
import argparse
import base64
import hashlib
import io
import os
import re
import sys
import tarfile
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
VERSION = "3.6.0"  # única fuente del número de versión: al compilar se copia a README, la página y package.json
# Dirección pública del sitio (docs/). Al pasar al dominio propio basta con cambiarla aquí, por ejemplo a
# "https://navestigio.com/", y compilar: se actualizan la URL canónica, Open Graph, los datos estructurados,
# hreflang, sitemap.xml y robots.txt, y se crea docs/CNAME para GitHub Pages.
SITE_URL = "https://radagora-labs.github.io/navestigio/"
SQLJS_VERSION = "1.15.2"
# Integridad publicada por npm para sql.js@1.15.2 (campo dist.integrity del registro).
SQLJS_INTEGRITY = "sha512-ZmMYFsZPZWDKIJUh3A5rdnpRV3hB/r7AijwAzSzLnfv/9CSx4obUmDtA8brAjWJWjGtUVh43nIEJ+6nl6HuOUg=="

# connect-src 'none': la página no puede enviar datos a ningún servidor.
# script-src: al compilar, 'unsafe-inline' se reemplaza por el SHA-256 de cada <script> de la página (apply_csp), así que
# un script o un manejador (onerror=…) que llegara a inyectarse no se ejecuta. La forma con 'unsafe-inline' queda solo
# como base del encabezado de servir_navestigio.py: el navegador aplica las dos políticas y manda la más estricta.
CSP = ("default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; "
       "img-src 'self' data: blob:; font-src data:; connect-src 'none'; manifest-src 'self'; worker-src 'self' blob:; "
       "base-uri 'none'; form-action 'none'; object-src 'none'")

FONTS = [  # (familia, pesos, archivo)
    ("Bricolage Grotesque", "600 800", "bricolage-grotesque-latin.woff2"),
    ("IBM Plex Sans", "400 600", "ibm-plex-sans-latin.woff2"),
    ("IBM Plex Mono", "400", "ibm-plex-mono-400-latin.woff2"),
    ("IBM Plex Mono", "500", "ibm-plex-mono-500-latin.woff2"),
]
RELEASE_FILES = ["navestigio.html", "servir_navestigio.py", "iniciar_navestigio.bat", "sw.js", "manifest.webmanifest",
                 "icon-192.png", "icon-512.png", "icon-maskable-512.png", "navestigio_favicon.svg", "navestigio_logo.svg", "navestigio_logo.png"]


def path(*p):
    return os.path.join(ROOT, *p)


def read(*p):
    with open(path(*p), "rb") as f:
        return f.read()


def verify_sums():
    ok = True
    for line in read("vendor", "SHA256SUMS").decode().splitlines():
        if not line.strip():
            continue
        digest, name = line.split(maxsplit=1)
        name = name.lstrip("*")
        got = hashlib.sha256(read("vendor", name)).hexdigest()
        if got != digest:
            print(f"[!] {name}: SHA-256 no coincide ({got})")
            ok = False
    if not ok:
        sys.exit("vendor/ fue modificado: no se genera navestigio.html")
    print("[+] vendor/SHA256SUMS verificado")


def verify_npm():
    url = f"https://registry.npmjs.org/sql.js/-/sql.js-{SQLJS_VERSION}.tgz"
    print(f"[.] Descargando {url}")
    tgz = urllib.request.urlopen(url, timeout=60).read()
    algo, b64 = SQLJS_INTEGRITY.split("-", 1)
    if base64.b64encode(hashlib.new(algo, tgz).digest()).decode() != b64:
        sys.exit("[!] El paquete descargado no coincide con la integridad publicada por npm")
    with tarfile.open(fileobj=io.BytesIO(tgz)) as t:
        for name in ("sql-wasm.js", "sql-wasm.wasm"):
            if t.extractfile(f"package/dist/{name}").read() != read("vendor", "sql.js", name):
                sys.exit(f"[!] vendor/sql.js/{name} no es idéntico al de npm")
    print(f"[+] vendor/sql.js es idéntico a sql.js@{SQLJS_VERSION} de npm")


def build_id():
    """Huella de compilación: SHA-256 de las fuentes, de vendor/SHA256SUMS y de la versión.
    Quien regenere desde el mismo código obtiene la misma huella; el manifiesto de cada exportación la registra."""
    h = hashlib.sha256(VERSION.encode())
    for parts in (("src", "navestigio.template.html"), ("src", "common.js"), ("src", "worker.js"), ("src", "app.js"), ("vendor", "SHA256SUMS")):
        h.update(b"\0" + "/".join(parts).encode() + b"\0" + read(*parts).replace(b"\r\n", b"\n"))
    return h.hexdigest()


# Solo se aplica a la plantilla propia ya armada; build() rechaza código que contenga "</script".
SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script\b[^>]*>", re.S | re.I)


def script_hashes(html):
    """SHA-256 (formato CSP) de cada <script> ejecutable; los type="text/plain" son datos para el Worker."""
    out = []
    for m in SCRIPT_RE.finditer(html):
        t = re.search(r'\btype\s*=\s*"([^"]*)"', m.group(1) or "", re.I)
        if t and t.group(1).lower() not in ("text/javascript", "module"):
            continue
        out.append("'sha256-" + base64.b64encode(hashlib.sha256(m.group(2).encode("utf-8")).digest()).decode() + "'")
    return out


def apply_csp(html, base=CSP):
    """Inserta la CSP en <!--@@CSP@@--> con los hashes de los scripts del HTML ya armado. Va al final del armado."""
    hashes = script_hashes(html)
    if not hashes or "script-src 'unsafe-inline'" not in base or html.count("<!--@@CSP@@-->") != 1:
        sys.exit("No se pudo armar la CSP con hashes")
    csp = base.replace("script-src 'unsafe-inline'", "script-src " + " ".join(hashes))
    return html.replace("<!--@@CSP@@-->", f'<meta http-equiv="Content-Security-Policy" content="{csp}">')


def build():
    html = read("src", "navestigio.template.html").decode("utf-8")
    fonts = "".join(
        f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{w};font-display:swap;"
        f"src:url(data:font/woff2;base64,{base64.b64encode(read('vendor', 'fonts', f)).decode()}) format('woff2')}}\n"
        for fam, w, f in FONTS)
    sqljs = read("vendor", "sql.js", "sql-wasm.js").decode("utf-8")
    code = {name: read("src", name).decode("utf-8") for name in ("common.js", "worker.js", "app.js")}
    for name, text in [("sql-wasm.js", sqljs)] + list(code.items()):
        if re.search(r"</script|<!--", text, re.I):
            sys.exit(f"{name} contiene </script o <!--: no se puede incrustar")
    wasm = base64.b64encode(read("vendor", "sql.js", "sql-wasm.wasm")).decode()
    parts = {
        "/*@@FONTS@@*/": "/* Fuentes: Bricolage Grotesque e IBM Plex (SIL OFL 1.1), ver THIRD_PARTY_NOTICES.md */\n" + fonts,
        "/*@@SQLJS@@*/": f"/* sql.js {SQLJS_VERSION} (MIT), ver THIRD_PARTY_NOTICES.md */\n" + sqljs,
        "/*@@WORKER@@*/": code["worker.js"],
        "/*@@COMMON@@*/": code["common.js"],
        "/*@@APP@@*/": code["app.js"],
        "@@WASM_B64@@": wasm,
        "@@VERSION@@": VERSION,
        "@@BUILD@@": build_id(),
    }
    for k, v in parts.items():
        if k not in html:
            sys.exit(f"Falta el marcador {k} en la plantilla")
        html = html.replace(k, v)
    html = apply_csp(html)
    out = path("app", "navestigio.html")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    print(f"[+] app/navestigio.html  {len(html.encode()):,} bytes  SHA-256 {hashlib.sha256(html.encode()).hexdigest()}")


# Dónde aparece el número de versión fuera de la app. Al compilar se actualizan solos desde VERSION, así que una versión
# nueva solo se cambia arriba; la integración continua comprueba que todos quedaron iguales.
VERSION_SPOTS = [
    (("README.md",), r"navestigio-\d+\.\d+\.\d+\.zip", "navestigio-{v}.zip"),
    (("docs", "index.html"), r"navestigio-\d+\.\d+\.\d+\.zip", "navestigio-{v}.zip"),
    (("docs", "index.html"), r'(<span class="eyebrow">)v\d+\.\d+\.\d+( · )', r"\g<1>v{v}\g<2>"),
    (("docs", "en", "index.html"), r"navestigio-\d+\.\d+\.\d+\.zip", "navestigio-{v}.zip"),
    (("docs", "en", "index.html"), r'(<span class="eyebrow">)v\d+\.\d+\.\d+( · )', r"\g<1>v{v}\g<2>"),
    (("package.json",), r'"version": "\d+\.\d+\.\d+"', '"version": "{v}"'),
    (("SECURITY.md",), r"La versión actual es la \d+\.\d+\.\d+\.", "La versión actual es la {v}."),
    (("THIRD_PARTY_NOTICES.md",), r"\(Navestigio \d+\.\d+\.\d+\)", "(Navestigio {v})"),
]


def sync_version():
    for parts, pat, rep in VERSION_SPOTS:
        text = read(*parts).decode("utf-8")
        new, n = re.subn(pat, rep.replace("{v}", VERSION), text)
        if not n:
            sys.exit(f"No se encontró el número de versión en {'/'.join(parts)} ({pat})")
        if new != text:
            with open(path(*parts), "w", encoding="utf-8", newline="\n") as f:
                f.write(new)
            print(f"[+] {'/'.join(parts)}: versión {VERSION}")


def site_files():
    for base, _, names in os.walk(path("docs")):
        for name in names:
            if name.endswith((".html", ".xml", ".txt")):
                yield os.path.join(base, name)


def sync_site_url():
    """Cambia la dirección anterior del sitio por SITE_URL en todas las páginas de docs/, el sitemap y robots.txt."""
    if not re.fullmatch(r"https://[a-z0-9.-]+/([a-z0-9-]+/)?", SITE_URL):
        sys.exit(f"SITE_URL debe ser https://dominio/ o https://dominio/carpeta/ (con la barra final): {SITE_URL}")
    m = re.search(r'<link rel="canonical" href="([^"]+)">', read("docs", "index.html").decode("utf-8"))
    if not m:
        sys.exit("No se encontró la URL canónica en docs/index.html")
    old = m.group(1)
    if old != SITE_URL:
        for f in site_files():
            with open(f, encoding="utf-8") as fh:
                text = fh.read()
            if old in text:
                with open(f, "w", encoding="utf-8", newline="\n") as fh:
                    fh.write(text.replace(old, SITE_URL))
                print(f"[+] {os.path.relpath(f, ROOT)}: {SITE_URL}")
    host = SITE_URL.split("/")[2]
    cname = path("docs", "CNAME")
    if host.endswith(".github.io"):
        if os.path.exists(cname):
            os.remove(cname)
            print("[+] docs/CNAME eliminado (el sitio vuelve a github.io)")
    elif not os.path.exists(cname) or read("docs", "CNAME").decode().strip() != host:
        with open(cname, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(host + "\n")
        print(f"[+] docs/CNAME: {host}")


def make_zip():
    os.makedirs(path("dist"), exist_ok=True)
    out = path("dist", f"navestigio-{VERSION}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name in RELEASE_FILES:
            z.write(path("app", name), f"navestigio/{name}")
        for name in ("README.md", "LICENSE", "LICENCIA-COMERCIAL.md", "THIRD_PARTY_NOTICES.md", "SECURITY.md"):
            z.write(path(name), f"navestigio/{name}")
    digest = hashlib.sha256(read("dist", os.path.basename(out))).hexdigest()
    with open(out + ".sha256", "w", encoding="utf-8", newline="\n") as f:
        f.write(f"{digest}  {os.path.basename(out)}\n")
    print(f"[+] {os.path.relpath(out, ROOT)}  SHA-256 {digest}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Construye Navestigio")
    ap.add_argument("--verificar-npm", action="store_true", help="compara vendor/sql.js con el paquete oficial de npm")
    ap.add_argument("--zip", action="store_true", help="arma el zip del release en dist/")
    a = ap.parse_args()
    verify_sums()
    if a.verificar_npm:
        verify_npm()
    sync_version()
    sync_site_url()
    build()
    if a.zip:
        make_zip()
