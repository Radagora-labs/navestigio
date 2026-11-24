/* Prueba de humo de Navestigio en Chromium (Playwright).
   Uso: node tests/smoke.cjs        (requiere Python 3 y Playwright; ver README, sección Pruebas)
   Genera evidencias sintéticas, sirve app/ en 127.0.0.1 y comprueba seguridad, detección e integridad de la exportación. */
"use strict";
const {chromium} = require("playwright");
const {spawn, execFileSync} = require("child_process");
const crypto = require("crypto"), fs = require("fs"), os = require("os"), path = require("path");

const ROOT = path.resolve(__dirname, ".."), APP = path.join(ROOT, "app"), PORT = 8799, BASE = `http://127.0.0.1:${PORT}/`;
const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const EV = fs.mkdtempSync(path.join(os.tmpdir(), "navestigio-ev-")), OUT = fs.mkdtempSync(path.join(os.tmpdir(), "navestigio-out-"));
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ok " : "FALLA"} ${msg}`); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Lector mínimo de ZIP sin compresión (el formato que genera Navestigio)
function unzip(buf) {
  const files = {}; let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const size = buf.readUInt32LE(o + 18), nl = buf.readUInt16LE(o + 26), xl = buf.readUInt16LE(o + 28);
    const name = buf.slice(o + 30, o + 30 + nl).toString("utf8"), start = o + 30 + nl + xl;
    files[name] = buf.slice(start, start + size); o = start + size;
  }
  return files;
}
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex"), md5 = b => crypto.createHash("md5").update(b).digest("hex");

(async () => {
  execFileSync(PY, [path.join(__dirname, "fixtures.py"), EV], {stdio: "inherit"});
  const srv = spawn(PY, [path.join(APP, "servir_navestigio.py"), "--port", String(PORT), "--no-browser"], {stdio: "ignore"});
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE)).ok) break; } catch (e) {} await sleep(200); }
    await require("./custodia.cjs")(browser);
    console.log("Recorrido guiado");
    const ctxT = await browser.newContext({viewport: {width: 1400, height: 1000}}), pt = await ctxT.newPage(), eT = [];
    pt.on("pageerror", e => eT.push(String(e)));
    await pt.goto(BASE); await pt.waitForSelector("#tour:not(.hide)", {timeout: 30000}); await sleep(600);
    ok(await pt.evaluate(() => document.activeElement.id === "tourNext" && /^Paso 1 de \d+$/.test(document.getElementById("tourN").textContent)), "aparece la primera vez, con el foco en «Empezar»");
    await pt.keyboard.press("ArrowRight"); await sleep(600);
    ok(await pt.evaluate(() => /^Paso 2 /.test(document.getElementById("tourN").textContent) && !document.getElementById("tourHole").classList.contains("none")), "las flechas avanzan e iluminan el elemento del paso");
    await pt.keyboard.press("Escape"); await sleep(300);
    ok(await pt.evaluate(() => document.getElementById("tour").classList.contains("hide") && localStorage.getItem("navestigio_tour") === null), "Esc lo cierra sin guardar la preferencia");
    await pt.reload(); await pt.waitForSelector("#tour:not(.hide)", {timeout: 30000}); await sleep(600);
    await pt.check("#tourNo"); await pt.click("#tourX"); await sleep(1500); await pt.reload();   // Chromium escribe el localStorage en lotes
    await pt.waitForFunction(() => document.querySelectorAll(".db").length >= 3, null, {timeout: 30000}); await sleep(1200);
    ok(await pt.evaluate(() => document.getElementById("tour").classList.contains("hide") && localStorage.getItem("navestigio_tour") === "oculto"), "con «No volver a mostrar» no aparece al abrir de nuevo");
    await pt.click("#btnTour"); await sleep(600);
    let steps = 0;
    while (steps < 30 && await pt.evaluate(() => !document.getElementById("tour").classList.contains("hide"))) { await pt.click("#tourNext"); await sleep(450); steps++; }
    ok(steps >= 8 && await pt.evaluate(() => S.src === "s:resumen"), `«Recorrido guiado» lo repite completo (${steps} pasos) y vuelve a la vista anterior`);
    ok(eT.length === 0, "el recorrido no produce errores " + JSON.stringify(eT));
    await ctxT.close();

    const ctx = await browser.newContext({acceptDownloads: true, viewport: {width: 1400, height: 1000}});
    await ctx.addInitScript(() => { try { localStorage.setItem("navestigio_tour", "oculto"); } catch (e) {} });
    const page = await ctx.newPage(), pageErrors = [], cspErrors = [], external = [];
    page.on("pageerror", e => pageErrors.push(String(e)));
    page.on("console", m => { if (/Content Security Policy|Refused to/i.test(m.text())) cspErrors.push(m.text()); });
    page.on("request", r => { if (!/^(http:\/\/127\.0\.0\.1:\d+\/|blob:|data:)/.test(r.url())) external.push(r.url()); });
    const click = async sel => { await page.click(sel); await sleep(700); };
    const gridText = () => page.evaluate(() => document.getElementById("grid").innerText);

    console.log("Carga y seguridad");
    await page.goto(BASE); await page.waitForFunction(() => document.querySelectorAll(".db").length >= 3, null, {timeout: 30000});
    ok(await page.evaluate(() => document.title) === "Navestigio", "la página carga con el título correcto");
    const hdr = (await fetch(BASE)).headers;
    ok(/connect-src 'none'/.test(hdr.get("content-security-policy") || ""), "el servidor envía la CSP que bloquea la red");
    const st = await new Promise(res => require("http").get({host: "127.0.0.1", port: PORT, path: "/", headers: {Host: "evil.example:" + PORT}}, r => { r.resume(); res(r.statusCode); }).on("error", () => res(0)));
    ok(st === 400, "el servidor rechaza otro Host (DNS rebinding)");
    ok(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length === 1), "el service worker queda registrado");

    console.log("Evidencias válidas y malformadas");
    const names = ["History", "Cookies", "recursiva.sqlite", "basura.sqlite", "truncada.sqlite", "ConWal", "ConWal-wal", "Preferences"];
    await page.setInputFiles("#files", names.map(n => path.join(EV, n)));
    await page.waitForFunction(() => !document.body.classList.contains("busy"), null, {timeout: 60000}); await sleep(2500);
    const opened = await page.evaluate(() => [...document.querySelectorAll(".db .dbh b small")].map(b => b.textContent));
    ok(opened.includes("History") && opened.includes("Cookies"), "abre History y Cookies junto a archivos malformados: " + opened.join(", "));
    ok(pageErrors.length === 0, "ninguna evidencia malformada produce errores no controlados " + JSON.stringify(pageErrors));

    console.log("Indicadores de integridad e interpretación");
    await click('.src[data-src="s:integridad"]');
    const integ = await gridText();
    for (const t of ["Faltan los 5 registros más recientes de visits", "Hueco de 20 id en visits", "retroceso de fecha en visits", "2 cookies creadas después de su último uso"])
      ok(integ.includes(t), "detecta: " + t);
    await click('.src[data-src="s:resumen"]');
    ok(await page.evaluate(() => /No se analizó/.test(document.getElementById("summary").innerText) && /valores de cookies cifrados/.test(document.getElementById("summary").innerText)), "el resumen muestra el alcance del análisis");
    await click('.src[data-src="s:timeline"]');
    ok((await gridText()).includes("Búsqueda en Google: «como borrar historial»"), "interpreta la búsqueda de Google en la línea de tiempo");
    ok(await page.evaluate(() => [...document.querySelectorAll("#grid th")].some(th => th.textContent.startsWith("confianza"))), "la línea de tiempo trae la columna de confianza");

    console.log("Exportaciones");
    const save = async (sel, name) => { const [d] = await Promise.all([page.waitForEvent("download"), page.click(sel)]); const f = path.join(OUT, name); await d.saveAs(f); return fs.readFileSync(f); };
    await page.selectOption("#expFmt", "jsonl");
    const jsonl = (await save("#btnCsv", "tl.jsonl")).toString("utf8").trim().split("\n");
    ok(jsonl.length > 50 && jsonl.every(l => { try { JSON.parse(l); return true; } catch (e) { return false; } }), `JSONL válido (${jsonl.length} líneas)`);
    await page.selectOption("#expFmt", "l2t");
    const l2t = (await save("#btnCsv", "tl.l2t.csv")).toString("utf8").replace(/^﻿/, "").split("\r\n").filter(Boolean);
    ok(l2t[0].split(",").length === 17, "l2t CSV con las 17 columnas de log2timeline");
    await page.selectOption("#expFmt", "body");
    const body = (await save("#btnCsv", "tl.body")).toString("utf8").trim().split("\n");
    ok(body.every(l => l.split("|").length === 11), "bodyfile con 11 campos por línea");
    await page.selectOption("#expFmt", "csv");
    const files = unzip(await save("#btnZip", "caso.zip"));
    ok(["manifest.json", "SHA256SUMS.txt", "LEEME_cadena_custodia.txt", "linea_de_tiempo.jsonl"].every(n => files[n]), "el ZIP trae manifiesto, sumas, cadena de custodia y línea de tiempo");
    ok(!files["informe.html"], "la versión gratuita no exporta informe");
    const sums = files["SHA256SUMS.txt"].toString("utf8").trim().split("\n").map(l => l.split(/\s+/));
    ok(sums.length === Object.keys(files).length - 1 && sums.every(([h, n]) => files[n] && sha256(files[n]) === h), "SHA256SUMS.txt verifica cada archivo del paquete");
    const man = JSON.parse(files["manifest.json"].toString("utf8")), hist = man.evidencias.find(e => e.nombre === "History" && !e.datos_de_ejemplo);
    const raw = fs.readFileSync(path.join(EV, "History"));
    ok(hist && hist.archivos[0].sha256 === sha256(raw) && hist.archivos[0].md5 === md5(raw), "el manifiesto registra SHA-256 y MD5 correctos de la evidencia");

    console.log("Vista hostil (recursión infinita) y cancelación");
    await page.evaluate(() => document.querySelector('.src[data-src="t:infinita"]').closest("details.db").open = true);
    await page.click('.src[data-src="t:infinita"]');
    await page.waitForSelector("#busy.cancelable", {timeout: 15000}); await page.click("#btnCancelQ");
    await page.waitForFunction(() => !document.body.classList.contains("busy") && document.querySelector('.src[data-src="s:resumen"].on'), null, {timeout: 60000});
    await click('.src[data-src="s:integridad"]');
    ok((await gridText()).includes("Hueco de 20 id en visits"), "tras cancelar, el caso se reconstruye con las evidencias abiertas");

    console.log("Carpeta de un usuario: Safari, sesión de Firefox, extensiones y perfiles");
    await page.setInputFiles("#folder", path.join(EV, "usuario"));
    await page.waitForFunction(() => !document.body.classList.contains("busy"), null, {timeout: 60000}); await sleep(2500);
    ok(pageErrors.length === 0, "la carpeta se abre sin errores " + JSON.stringify(pageErrors));
    await click('.src[data-src="s:perfiles"]');
    const prof = await gridText();
    for (const t of ["Google Chrome", "Firefox", "Safari", "x1y2.default-release"]) ok(prof.includes(t), "detecta el perfil: " + t);
    ok(/\bana\b/.test(prof), "identifica al usuario por la ruta");
    await click('.src[data-src="s:integridad"]');
    ok((await gridText()).includes("Historial borrado en Safari"), "detecta el tombstone de Safari como borrado de historial");
    await click('.src[data-src="s:timeline"]');
    await page.fill("#q", "safari3.example.com"); await page.press("#q", "Enter"); await sleep(1200);
    ok((await gridText()).includes("Visita (Safari)"), "las visitas de Safari llegan a la línea de tiempo");
    await page.fill("#q", "wetransfer"); await page.press("#q", "Enter"); await sleep(1200);
    ok((await gridText()).includes("Pestaña cerrada (Firefox)"), "lee sessionstore.jsonlz4 y muestra la pestaña cerrada");
    await page.fill("#q", ""); await page.press("#q", "Enter"); await sleep(600);
    await click('.src[data-src="p:chrome_ext"]');
    const ext = await gridText();
    ok(ext.includes("Ayudante de compras") && ext.includes("<all_urls>"), "lee el manifiesto de la extensión, su nombre traducido y sus permisos sensibles");
    await click('.src[data-src="p:ff_addons"]');
    ok((await gridText()).includes("Grabador de pestañas"), "lee los complementos de Firefox (extensions.json)");

    console.log("Barra lateral: categorías, vistas destacadas y cerrar todas");
    const side = await page.evaluate(() => ({cats: [...document.querySelectorAll("#side .sgrp:not(.stars)>summary")].map(e => e.firstChild.textContent.trim()),
      stars: document.querySelectorAll("#side .sgrp.stars .src.preset").length, firstAfterCase: (document.querySelector("#side .dbcase + details") || {}).className,
      starSub: (document.querySelector('#side .sgrp.stars .src[data-src="p:safari_history"] small') || {}).textContent || "",
      cardsInStars: document.querySelectorAll("#side details.db .src.preset").length}));
    ok(["Historial y descargas", "Cookies", "Sesiones y pestañas", "Extensiones y complementos"].every(c => side.cats.includes(c)), "agrupa las evidencias por categoría: " + side.cats.join(", "));
    ok(side.firstAfterCase === "sgrp stars" && side.stars >= 6 && side.cardsInStars === 0, "las vistas destacadas (★) van juntas justo después del análisis del caso");
    ok(/Safari/.test(side.starSub) && /History\.db/.test(side.starSub), "cada vista destacada dice de qué navegador y archivo viene: " + side.starSub);
    await page.click('#side .sgrp[data-k="c:cookies"]>summary'); await sleep(200);
    ok(await page.evaluate(() => !document.querySelector('#side .sgrp[data-k="c:cookies"]').open), "las categorías se pliegan");
    await click('.src[data-src="s:timeline"]');
    ok(await page.evaluate(() => !document.querySelector('#side .sgrp[data-k="c:cookies"]').open), "una categoría plegada sigue plegada al cambiar de vista");

    console.log("Modo captura de hallazgos");
    await page.click('#grid [data-mark="0"]'); await sleep(800);
    await click('.src[data-src="s:hallazgos"]');
    await page.dblclick('#grid tr[data-row="0"] td:nth-child(3)'); await sleep(400);
    await page.fill("#mkNote", "Nota de prueba del analista"); await page.click("#mkSave"); await sleep(900);
    await page.evaluate(() => document.getElementById("detail").classList.add("hide"));
    await click("#btnCapture");
    const cap = await page.evaluate(() => ({cards: document.querySelectorAll("#grid .fcard").length, note: (document.querySelector("#grid .fcard .fnote") || {}).textContent || "",
      prov: (document.querySelector("#grid .fcard .fprov") || {}).textContent || "", hashes: (document.querySelector("#caption").textContent.match(/SHA-256 /g) || []).length,
      folded: !!document.querySelector("#caption details.prov:not([open])"), all: CASE.hashes.length}));
    ok(cap.cards === 1 && /Nota de prueba del analista/.test(cap.note) && /SHA-256 [0-9a-f]{64}/.test(cap.prov), "en modo captura el hallazgo se ve con su nota y el SHA-256 de su evidencia");
    ok(cap.all > 3 && cap.hashes <= 2 && cap.folded, "la lista de todas las evidencias va plegada aparte, no encima del hallazgo " + JSON.stringify(cap));
    await page.keyboard.press("Escape"); await sleep(400);
    ok(await page.evaluate(() => !document.querySelector("#grid .fcard") && !!document.querySelector("#grid table")), "al salir del modo captura vuelve la tabla");
    await page.click('#grid [data-mark="0"]'); await sleep(800);
    page.once("dialog", d => d.accept());
    await page.click("#side [data-closeall]"); await page.waitForFunction(() => !document.body.classList.contains("busy"), null, {timeout: 60000}); await sleep(1200);
    const after = await page.evaluate(() => ({n: realDbs().length, welcome: !document.getElementById("welcome").classList.contains("hide"), groups: document.querySelectorAll("#side .sgrp").length,
      tl: CASE.src("s:timeline").rows}));
    ok(after.n === 0 && after.welcome && after.groups === 0 && after.tl === 0, "«Cerrar todas» deja el caso en limpio para el siguiente navegador " + JSON.stringify(after));
    ok(pageErrors.length === 0, "la barra lateral no produce errores " + JSON.stringify(pageErrors));

    console.log("Sesiones de Firefox manipuladas (mozLz4)");
    for (const [name, re] of [["encabezado-falso.jsonlz4", /no abierta: declara 512 MB descomprimidos, más que el límite de 128 MB/], ["bomba.jsonlz4", /no abierta: declara 129 MB/]]) {
      await page.setInputFiles("#files", path.join(EV, name)); await sleep(800);
      await page.waitForFunction(() => !document.body.classList.contains("busy"), null, {timeout: 30000});
      const st = await page.evaluate(() => ({toast: document.getElementById("toast").textContent, n: realDbs().length}));
      ok(re.test(st.toast) && st.n === 0, `${name}: se rechaza con un aviso claro antes de leerlo (${st.toast})`);
    }
    ok(pageErrors.length === 0 && await page.evaluate(() => !document.body.classList.contains("busy")), "la app sigue respondiendo después de los archivos manipulados " + JSON.stringify(pageErrors));

    console.log("Datos con HTML (inyección) y CSP");
    {
      const ctxH = await browser.newContext({viewport: {width: 1400, height: 1000}});
      await ctxH.addInitScript(() => { try { localStorage.setItem("navestigio_tour", "oculto"); } catch (e) {} });
      const ph = await ctxH.newPage(), eH = [], dialogs = [];
      ph.on("pageerror", e => eH.push(String(e))); ph.on("dialog", d => { dialogs.push(d.message()); d.dismiss(); });
      await ph.goto(BASE); await ph.waitForFunction(() => document.querySelectorAll(".db").length >= 3, null, {timeout: 30000});
      const meta = await ph.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
      const scriptSrc = (meta.match(/script-src([^;]*)/) || [])[1] || "";
      ok(!/unsafe-inline/.test(scriptSrc) && (scriptSrc.match(/'sha256-/g) || []).length === 2, "la CSP de la página permite solo sus 2 scripts por hash, sin 'unsafe-inline'");
      await ph.evaluate(() => { const d = document.createElement("div"); d.innerHTML = '<img src="data:," onerror="window.__csp=1">'; document.body.appendChild(d); });
      await sleep(500);
      ok(await ph.evaluate(() => window.__csp === undefined), "un manejador en línea inyectado no se ejecuta (lo bloquea la CSP)");
      await ph.setInputFiles("#folder", path.join(EV, "hostil"));
      await ph.waitForFunction(() => !document.body.classList.contains("busy"), null, {timeout: 60000}); await sleep(2000);
      await ph.evaluate(() => document.querySelectorAll("#side details").forEach(d => d.open = true));
      const srcs = await ph.evaluate(() => [...document.querySelectorAll(".src[data-src]")].map(e => e.dataset.src).filter(s => s !== "t:infinita"));
      for (const s of srcs) {
        await ph.evaluate(s => document.querySelector(`.src[data-src="${CSS.escape(s)}"]`).click(), s); await sleep(250);
        await ph.waitForFunction(() => !document.body.classList.contains("busy"), null, {timeout: 30000});
        const row = await ph.$("#grid tbody tr[data-row]");
        if (row && await row.isVisible()) { await row.dblclick({timeout: 5000}); await sleep(200); await ph.evaluate(() => document.getElementById("detail").classList.add("hide")); }
      }
      const inj = await ph.evaluate(() => ({xss: window.__xss, nodes: document.querySelectorAll("[onerror],[onload],[onmouseover]").length,
        visible: document.body.innerText.includes('<img src=x onerror="window.__xss=1">')}));
      ok(srcs.length > 10 && inj.xss === undefined && inj.nodes === 1 && inj.visible,
        `${srcs.length} vistas y su detalle muestran el HTML de la evidencia como texto, sin crear elementos ` + JSON.stringify(inj));
      ok(eH.length === 0 && dialogs.length === 0, "sin errores ni diálogos " + JSON.stringify(eH.concat(dialogs).slice(0, 3)));
      await ctxH.close();
    }

    console.log("Modo archivo local (doble clic)");
    const p2 = await ctx.newPage(), e2 = []; p2.on("pageerror", e => e2.push(String(e)));
    await p2.goto("file://" + path.join(APP, "navestigio.html").replace(/\\/g, "/")); await p2.waitForFunction(() => document.querySelectorAll(".db").length >= 3, null, {timeout: 30000});
    ok(e2.length === 0, "abre sin errores desde file://");

    ok(cspErrors.length === 0, "sin violaciones de CSP " + JSON.stringify(cspErrors.slice(0, 3)));
    ok(external.length === 0, "ninguna petición sale de 127.0.0.1 " + JSON.stringify(external.slice(0, 3)));
  } catch (e) { console.error(e); fails++; }
  finally { await browser.close(); srv.kill(); }
  console.log(fails ? `\n${fails} pruebas fallaron` : "\nTodas las pruebas pasaron");
  process.exit(fails ? 1 : 0);
})();
