#!/usr/bin/env python3
"""Cada asignación de HTML (innerHTML, outerHTML, insertAdjacentHTML) en src/ está revisada: todo dato de la
evidencia pasa por esc() antes de llegar ahí. Si aparece una nueva, esta prueba falla hasta que alguien la revise
y actualice el conteo de abajo. Uso: python tests/revisar_html.py"""
import os
import re
import sys

REVISADAS = {"app.js": 12, "common.js": 0, "worker.js": 0}  # revisadas para 3.5.1
SINK = re.compile(r"\.(?:innerHTML|outerHTML)\s*\+?=(?!=)|insertAdjacentHTML\s*\(")
SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")

fails = 0
for name in sorted(f for f in os.listdir(SRC) if f.endswith(".js")):
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        lines = [i + 1 for i, line in enumerate(f) for _ in SINK.finditer(line)]
    want = REVISADAS.get(name, 0)
    if len(lines) != want:
        fails += 1
        print(f"FALLA src/{name}: {len(lines)} asignaciones de HTML (revisadas: {want}), líneas {lines}. "
              "Revise que cada dato pase por esc() y actualice REVISADAS en tests/revisar_html.py.")
    else:
        print(f"  ok  src/{name}: {want} asignaciones de HTML revisadas")
sys.exit(1 if fails else 0)
