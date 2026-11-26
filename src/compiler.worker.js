// Persistent worker: Clang + LLD (WebAssembly) compiling C/C++ to a wasm32-wasi executable.
import { runClang, Exit } from '@yowasp/clang';

const dec = new TextDecoder();
// Makes stdout unbuffered so prompts ("Name? ") show up before the program waits for input.
const PRELUDE = '#include <stdio.h>\n__attribute__((constructor)) static void __ide_init(void){ setvbuf(stdout, 0, _IONBF, 0); }\n';

self.onmessage = async ({ data }) => {
  const { id, lang, code, std, opt } = data;
  const cpp = lang === 'cpp', ext = cpp ? 'cpp' : 'c';
  let diag = '';
  const sink = (b) => { if (b) diag += typeof b === 'string' ? b : dec.decode(b); };
  const args = [
    cpp ? 'clang++' : 'clang', `-std=${std}`, `-${opt}`, '-Wall',
    '-Wl,-z,stack-size=8388608',                 // 8 MB stack
    ...(cpp ? ['-fno-exceptions'] : []),         // bundled libc++ is built without exceptions
    `main.${ext}`, `prelude.${ext}`, '-o', 'a.out',
  ];
  const t0 = performance.now();
  try {
    const out = await runClang(args, { [`main.${ext}`]: code, [`prelude.${ext}`]: PRELUDE }, {
      stdout: sink, stderr: sink,
      fetchProgress: ({ doneLength, totalLength }) => self.postMessage({ id, type: 'progress', done: doneLength, total: totalLength }),
    });
    const wasm = out['a.out'];
    self.postMessage({ id, type: 'done', ok: true, diag, ms: performance.now() - t0, wasm }, [wasm.buffer]);
  } catch (e) {
    if (e instanceof Exit) self.postMessage({ id, type: 'done', ok: false, diag, ms: performance.now() - t0 });
    else self.postMessage({ id, type: 'done', ok: false, diag: diag + '\ninternal error: ' + (e?.stack || e) + '\n', ms: 0 });
  }
};
