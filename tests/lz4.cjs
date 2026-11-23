/* Pruebas del lector mozLz4 (sessionstore.jsonlz4 de Firefox) contra archivos manipulados.
   Uso: node tests/lz4.cjs   (no necesita navegador: carga src/common.js y src/worker.js en un contexto aislado) */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");

const SRC = path.resolve(__dirname, "..", "src");
const ctx = vm.createContext({TextDecoder, TextEncoder, console});
vm.runInContext(fs.readFileSync(path.join(SRC, "common.js"), "utf8") + "\n" + fs.readFileSync(path.join(SRC, "worker.js"), "utf8") +
  "\n;globalThis.T = {mozLz4, isMozLz4, mozLz4Problem, MAX: MOZLZ4_MAX_OUT};", ctx);
const {mozLz4, isMozLz4, mozLz4Problem, MAX} = ctx.T;

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ok " : "FALLA"} ${msg}`); if (!cond) fails++; };
const throws = (fn, re, msg) => { let e = null; try { fn(); } catch (x) { e = x; } ok(e && re.test(e.message), msg + (e ? ` («${e.message}»)` : " (no lanzó error)")); };

const head = n => { const b = Buffer.alloc(12); b.write("mozLz40\0", 0, "latin1"); b.writeUInt32LE(n >>> 0, 8); return b; };
const ext = n => { const o = []; while (n >= 255) { o.push(255); n -= 255; } o.push(n); return o; };
// Bloque válido de solo literales
const literal = data => Buffer.concat([head(data.length), Buffer.from([data.length >= 15 ? 0xF0 : data.length << 4, ...(data.length >= 15 ? ext(data.length - 15) : [])]), data]);
// Bomba real: un literal y una referencia de distancia 1 que lo repite hasta llegar a «total» bytes (LZ4 válido)
const bomb = total => { const ml = total - 1 - 4; return Buffer.concat([head(total), Buffer.from([0x1F, 0x61, 1, 0, ...ext(ml - 15)])]); };
const u8 = b => new Uint8Array(b.buffer, b.byteOffset, b.length);

console.log("Lector mozLz4");
const json = Buffer.from(JSON.stringify({windows: [], session: {}, version: ["sessionrestore", 1]}));
ok(Buffer.from(mozLz4(u8(literal(json)))).equals(json), "una sesión válida se descomprime igual que antes");
const b1 = bomb(1 << 20);
ok(isMozLz4(u8(b1)) && mozLz4(u8(b1)).length === 1 << 20, `una referencia comprimida válida se expande bien (${b1.length} bytes → 1 MiB)`);
throws(() => mozLz4(u8(Buffer.concat([head(512 * 1024 * 1024), Buffer.alloc(20)]))), /límite/, "encabezado que declara 512 MiB: rechazado sin reservar memoria");
throws(() => mozLz4(u8(bomb(MAX + 1))), /límite/, "bomba LZ4 válida de 128 MiB + 1 byte: rechazada");
throws(() => mozLz4(u8(Buffer.concat([head(100 * 1024 * 1024), Buffer.alloc(20)]))), /manipulado/, "100 MiB declarados con 20 bytes de datos: rechazado por la relación de compresión");
const atMax = bomb(MAX);
ok(mozLz4(u8(atMax)).length === MAX, `justo en el límite: una sesión de 128 MiB (${atMax.length} bytes comprimidos) se abre`);
ok(mozLz4Problem(MAX + 1, 1 << 20) !== "", "un byte por encima del límite: se rechaza");
ok(mozLz4Problem(1000, 64 * 1024 * 1024 + 1) !== "", "archivo comprimido de más de 64 MiB: se rechaza");
const short = literal(json); short.writeUInt32LE(json.length + 10, 8);
throws(() => mozLz4(u8(short)), /incompleto/, "produce menos bytes de los declarados: avisa en vez de aceptar en silencio");
throws(() => mozLz4(u8(literal(json).subarray(0, 30))), /inválido|truncado|incompleto/, "bloque truncado: error claro");
throws(() => mozLz4(u8(Buffer.concat([head(40), Buffer.from([0x1F, 0x61, 0, 0, 20])]))), /referencia/, "referencia con distancia 0: rechazada");
throws(() => mozLz4(u8(Buffer.concat([head(40), Buffer.from([0x1F, 0x61, 5, 0, 20])]))), /referencia/, "referencia más atrás de lo ya escrito: rechazada");
throws(() => mozLz4(u8(Buffer.concat([head(10), Buffer.from([0xF0, 255, 255])]))), /inválido|truncado/, "longitud de literales que sale del archivo: rechazada");

console.log(fails ? `\n${fails} pruebas fallaron` : "\nTodas las pruebas de mozLz4 pasaron");
process.exit(fails ? 1 : 0);
