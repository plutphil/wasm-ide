// Minimal WASI (preview1) host: stdin/stdout/stderr + args. Nothing else is available.
export class ProcExit extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}

/** Shell-like split: foo "bar baz" 'x y' -> ["foo","bar baz","x y"] */
export function splitArgs(s) {
  const out = []; let cur = '', quote = null, has = false;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/**
 * Runs a WASI command module. Returns main()'s return value (exit code).
 * readStdin(maxLen) -> Uint8Array (blocking; empty array = EOF)
 * write(fd, bytes)  -> called for stdout (1) and stderr (2)
 */
export async function runProgram(bytes, { args, readStdin, write }) {
  const module = await WebAssembly.compile(bytes);
  const enc = new TextEncoder();
  let mem;
  const dv = () => new DataView(mem.buffer);
  const u8 = () => new Uint8Array(mem.buffer);
  const argv = args.map((a) => enc.encode(a + '\0'));
  const BADF = 8, NOSYS = 52, SPIPE = 70;

  const wasi = {
    args_sizes_get(pc, ps) {
      const d = dv();
      d.setUint32(pc, argv.length, true);
      d.setUint32(ps, argv.reduce((n, a) => n + a.length, 0), true);
      return 0;
    },
    args_get(pv, pb) {
      const d = dv(), m = u8();
      for (const a of argv) { d.setUint32(pv, pb, true); pv += 4; m.set(a, pb); pb += a.length; }
      return 0;
    },
    environ_sizes_get(pc, ps) { const d = dv(); d.setUint32(pc, 0, true); d.setUint32(ps, 0, true); return 0; },
    environ_get() { return 0; },
    clock_time_get(id, _prec, out) {
      const ns = id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.round(performance.now() * 1e6));
      dv().setBigUint64(out, ns, true); return 0;
    },
    clock_res_get(_id, out) { dv().setBigUint64(out, 1000n, true); return 0; },
    random_get(p, n) {
      const m = u8();
      for (let o = 0; o < n; o += 65536) crypto.getRandomValues(m.subarray(p + o, p + Math.min(n, o + 65536)));
      return 0;
    },
    sched_yield() { return 0; },
    proc_exit(code) { throw new ProcExit(code); },
    fd_write(fd, iovs, n, pnw) {
      if (fd !== 1 && fd !== 2) return BADF;
      const d = dv(), m = u8(); let total = 0; const parts = [];
      for (let i = 0; i < n; i++) {
        const p = d.getUint32(iovs + i * 8, true), l = d.getUint32(iovs + i * 8 + 4, true);
        parts.push(m.slice(p, p + l)); total += l;
      }
      const buf = new Uint8Array(total); let o = 0;
      for (const x of parts) { buf.set(x, o); o += x.length; }
      write(fd, buf);
      d.setUint32(pnw, total, true); return 0;
    },
    fd_read(fd, iovs, n, pnr) {
      if (fd !== 0) return BADF;
      const d = dv(); let ptr = 0, len = 0;
      for (let i = 0; i < n; i++) {
        len = d.getUint32(iovs + i * 8 + 4, true);
        if (len) { ptr = d.getUint32(iovs + i * 8, true); break; }
      }
      const data = len ? readStdin(len) : new Uint8Array(0);
      u8().set(data, ptr);
      d.setUint32(pnr, data.length, true); return 0;
    },
    fd_fdstat_get(fd, p) {
      if (fd > 2) return BADF;
      const d = dv();
      d.setUint8(p, 2); d.setUint16(p + 2, 0, true);           // character device
      d.setBigUint64(p + 8, 0xffffffffffffffffn, true);
      d.setBigUint64(p + 16, 0xffffffffffffffffn, true); return 0;
    },
    fd_filestat_get(fd, p) {
      if (fd > 2) return BADF;
      u8().fill(0, p, p + 64); dv().setUint8(p + 16, 2); return 0;
    },
    fd_close(fd) { return fd <= 2 ? 0 : BADF; },
    fd_seek(fd) { return fd <= 2 ? SPIPE : BADF; },
    fd_tell(fd) { return fd <= 2 ? SPIPE : BADF; },
    fd_fdstat_set_flags() { return 0; },
    fd_prestat_get() { return BADF; },       // no preopened directories
    fd_prestat_dir_name() { return BADF; },
  };

  const imports = { wasi_snapshot_preview1: {} };
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module === 'wasi_snapshot_preview1') imports.wasi_snapshot_preview1[imp.name] = wasi[imp.name] || (() => NOSYS);
  }
  const instance = await WebAssembly.instantiate(module, imports);
  mem = instance.exports.memory;
  try { instance.exports._start(); return 0; }
  catch (e) { if (e instanceof ProcExit) return e.code; throw e; }
}
