// One-shot worker per run. Terminating it = Stop button. Blocks on stdin via SharedArrayBuffer.
import { runProgram } from './wasi.js';

const N = 65536;
function makeReader(sab) {
  if (!sab) return () => new Uint8Array(0);               // no isolation -> stdin is always EOF
  const c = new Int32Array(sab, 0, 4);                     // [head, tail, eof, signal]
  const data = new Uint8Array(sab, 16, N);
  return (len) => {
    for (;;) {
      const sig = Atomics.load(c, 3);
      const head = Atomics.load(c, 0), tail = c[1];
      if (head !== tail) {
        const n = Math.min(len, (head - tail + N) % N);
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) out[i] = data[(tail + i) % N];
        Atomics.store(c, 1, (tail + n) % N);
        return out;
      }
      if (Atomics.load(c, 2)) return new Uint8Array(0);   // EOF
      Atomics.wait(c, 3, sig);
    }
  };
}

self.onmessage = async ({ data: { wasm, args, stdin } }) => {
  const t0 = performance.now();
  try {
    const code = await runProgram(wasm, {
      args, readStdin: makeReader(stdin),
      write: (fd, bytes) => self.postMessage({ type: 'out', fd, bytes }, [bytes.buffer]),
    });
    self.postMessage({ type: 'exit', code, ms: performance.now() - t0 });
  } catch (e) {
    self.postMessage({ type: 'crash', message: String(e?.message || e), ms: performance.now() - t0 });
  }
};
