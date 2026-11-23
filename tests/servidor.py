#!/usr/bin/env python3
"""Pruebas del servidor local (app/servir_navestigio.py): solo atiende a la propia Navestigio.

Uso: python tests/servidor.py   (sin dependencias; levanta el servidor en un puerto libre y lo cierra al final)
"""
import http.client
import os
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "app", "servir_navestigio.py")
fails = 0


def ok(cond, msg):
    global fails
    print(("  ok  " if cond else "FALLA ") + msg)
    if not cond:
        fails += 1


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def req(port, method="GET", path="/", headers=None, host=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    h = {"Host": host or f"127.0.0.1:{port}"}
    h.update(headers or {})
    c.request(method, path, headers=h)
    r = c.getresponse()
    r.read()
    c.close()
    return r


def main():
    port = free_port()
    srv = subprocess.Popen([sys.executable, SERVER, "--port", str(port), "--no-browser"], stdout=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=1).close()
                break
            except OSError:
                time.sleep(0.1)
        print("Servidor local")
        r = req(port)
        ok(r.status == 200 and r.getheader("Cross-Origin-Resource-Policy") == "same-origin", "la página se entrega con Cross-Origin-Resource-Policy: same-origin")
        ok(req(port, headers={"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image"}, path="/favicon.svg").status == 200,
           "la propia página puede pedir sus archivos")
        ok(req(port, headers={"Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}).status == 200,
           "se abre escribiendo la dirección o desde el acceso directo")
        ok(req(port, headers={"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}).status == 200,
           "un enlace desde otro sitio abre la aplicación en una pestaña")
        ok(req(port, path="/icon-512.png", headers={"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image"}).status == 403,
           "otro sitio no puede incrustar sus archivos (<img>)")
        ok(req(port, headers={"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty", "Origin": "https://malo.example"}).status == 403,
           "otro sitio no puede pedirla con fetch")
        ok(req(port, headers={"Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script"}).status == 403,
           "otra aplicación en 127.0.0.1 con otro puerto tampoco")
        ok(req(port, headers={"Origin": "http://127.0.0.1:1"}).status == 403, "un Origin ajeno se rechaza aunque falten los encabezados Sec-Fetch")
        ok(req(port, host="malo.example").status == 400, "un Host ajeno se rechaza (DNS rebinding)")
        r = req(port, method="POST")
        ok(r.status == 405 and r.getheader("Allow") == "GET, HEAD", "POST responde 405 y solo admite GET y HEAD")
        ok(req(port, method="OPTIONS").status == 405, "OPTIONS responde 405")
        ok(req(port, path="/../servir_navestigio.py").status == 404, "rutas fuera de la lista: 404")

        # 16 conexiones abiertas sin pedir nada: la siguiente espera su turno y se atiende cuando se liberan
        idle = [socket.create_connection(("127.0.0.1", port)) for _ in range(16)]
        time.sleep(0.3)
        t0 = time.time()
        late = socket.create_connection(("127.0.0.1", port), timeout=30)
        late.sendall(f"GET / HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n".encode())
        first = late.recv(12)
        waited = time.time() - t0
        ok(first.startswith(b"HTTP/1.0 200") and waited > 5, f"la conexión 17 espera a que se cierren las ociosas (esperó {waited:.1f} s, cierre a los 10 s)")
        late.close()
        for s in idle:
            s.close()
        ok(req(port).status == 200, "después sigue atendiendo con normalidad")
    finally:
        srv.terminate()
        srv.wait()
    print(f"\n{fails} pruebas fallaron" if fails else "\nTodas las pruebas del servidor pasaron")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
