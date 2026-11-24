"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {execFileSync} = require("node:child_process");

// Perfil de navegador desechable; las bases y el journal solo contienen datos sintéticos.
module.exports = async function comprobarCustodia(browser) {
  const context = await browser.newContext({acceptDownloads: true});
  try {
    const page = await context.newPage();
    await context.addInitScript(() => localStorage.setItem("navestigio_tour", "oculto"));
    await page.goto(pathToFileURL(path.resolve(__dirname, "../app/navestigio.html")).href);
    await page.waitForFunction(() => typeof CASE !== "undefined" && CASE?.hashes.length >= 2);
    const result = await page.evaluate(async () => {
      const build = stmts => DB.call("build", {stmts});
      const a = await build([['CREATE TABLE "datos A"(dato TEXT)'], ["CREATE TABLE datos_A(dato TEXT)"],
        ['INSERT INTO "datos A" VALUES (?)', ["primera"]], ["INSERT INTO datos_A VALUES (?)", ["segunda"]]]);
      const b = await build([["CREATE TABLE cookies(creation_utc INTEGER, host_key TEXT, name TEXT)"],
        ["INSERT INTO cookies VALUES (13350000000000000,?,?)", ["ejemplo.invalid", "prueba"]]]);
      const before = realDbs().length;
      await openFiles([new File([a], "History"), new File([b], "History")]);
      const ambiguous = realDbs().length === before && $("toast").textContent.includes("ambigua");
      const first = await loadEvidence("History", "History", a, null, null, false);
      const second = await loadEvidence("History", "History", b, null, new Blob(["journal de prueba"]), false);
      await rebuildCase();
      S.db = CASE.id; S.src = "s:timeline";
      S.data = await fetchRows(CASE, S.src, 0, {...NOF, q: "ejemplo.invalid"}, null, false, 0, 20);
      const mark = await addMark(0);
      const {not} = scopeInfo([second]);
      const hi = buildWhere(["fecha"], {fecha: "unix_us"}, {...NOF, col: "fecha", to: "2026-01-01T12:00:00"})[0];
      const oldZone = $("tz").value;
      $("tz").value = "0";
      const end = rawBound(localToUtcMs("2026-01-01T12:00:00", true), "unix_us");
      $("tz").value = oldZone;
      S.db = first.id;
      return {ambiguous, rightSource: mark.sha === second.hashes[0][1] && mark.origen === second.origen,
        isolated: marksOf([first]).length === 0 && marksOf([second]).some(m => m.id === mark.id),
        diagnostic: not.some(s => s.includes("cookies") && s.includes("omitida")),
        upperExclusive: hi.includes(" < ") && end === String(Date.parse("2026-01-01T12:00:01Z") * 1000)};
    });
    for (const [name, value] of Object.entries(result)) assert.equal(value, true, name);

    const download = page.waitForEvent("download");
    await page.evaluate(() => exportZip());
    const archive = await (await download).path();
    const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
    const checkZip = [
      "import json, sys, zipfile, hashlib",
      "with zipfile.ZipFile(sys.argv[1]) as z:",
      "    names = z.namelist()",
      "    assert len(names) == len(set(n.casefold() for n in names))",
      "    m = json.loads(z.read('manifest.json'))",
      "    assert len(m['evidencias']) == 1 and m['hallazgos_marcados'] == 0",
      "    assert m['alcance']['analizado'][0].startswith('1 evidencia abierta')",
      "    assert 'journal de History' not in z.read('LEEME_cadena_custodia.txt').decode()",
      "    tables = {f['tabla']: z.read(f['archivo']).decode('utf-8-sig') for f in m['archivos'] if 'tabla' in f}",
      "    assert 'primera' in tables['datos A'] and 'segunda' in tables['datos_A']",
      "    for line in z.read('SHA256SUMS.txt').decode().splitlines():",
      "        digest, name = line.split('  ', 1)",
      "        assert hashlib.sha256(z.read(name)).hexdigest() == digest"
    ].join("\n");
    execFileSync(python, ["-c", checkZip, archive], {stdio: "inherit"});

    const failures = await page.evaluate(async () => {
      const originalSave = saveFile, originalFmt = fmtFor;
      let saves = 0, err = "";
      try {
        saveFile = () => { saves++; };
        fmtFor = async (...args) => {
          if (args.at(-1) === "jsonl") throw new Error("formato indisponible");
          return originalFmt(...args);
        };
        S.db = CASE.id;
        try { await exportZip(); } catch (e) { err = e.message; }
      } finally { fmtFor = originalFmt; saveFile = originalSave; }
      const setter = Storage.prototype.setItem;
      let durable;
      try {
        Storage.prototype.setItem = () => { throw new Error("cuota"); };
        durable = saveMarks();
      } finally { Storage.prototype.setItem = setter; }
      const digest = SubtleCrypto.prototype.digest;
      let hashError = false;
      try {
        SubtleCrypto.prototype.digest = async () => { throw new Error("digest indisponible"); };
        try { await sha256(new Uint8Array([1])); } catch (e) { hashError = e.message.includes("SHA-256"); }
      } finally { SubtleCrypto.prototype.digest = digest; }
      return {zip: !saves && err === "formato indisponible", memory: durable === false && MARKS.length > 0, hashError};
    });
    assert.deepEqual(failures, {zip: true, memory: true, hashError: true});
  } finally { await context.close(); }
};
