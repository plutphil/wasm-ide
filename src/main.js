import './style.css';
import '@xterm/xterm/css/xterm.css';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { splitArgs } from './wasi.js';

self.MonacoEnvironment = { getWorker: () => new editorWorker() };

const SAMPLES = {
  c: `#include <stdio.h>

int main(int argc, char **argv) {
    printf("argc = %d\\n", argc);
    for (int i = 1; i < argc; i++) printf("argv[%d] = %s\\n", i, argv[i]);

    char name[64];
    printf("What is your name? ");
    if (scanf("%63s", name) == 1) printf("Hello, %s!\\n", name);
    return 42;
}
`,
  cpp: `#include <iostream>
#include <string>

int main(int argc, char** argv) {
    std::cout << "argc = " << argc << "\\n";
    for (int i = 1; i < argc; i++) std::cout << "argv[" << i << "] = " << argv[i] << "\\n";

    std::string name;
    std::cout << "What is your name? ";
    if (std::cin >> name) std::cout << "Hello, " << name << "!\\n";
    return 42;
}
`,
};
const STDS = { c: ['c11', 'c17', 'c99', 'gnu11', 'gnu17'], cpp: ['c++17', 'c++20', 'c++23', 'c++14', 'c++11', 'gnu++17'] };

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- editor ----------
let lang = store.get('ide.lang', 'c');
const codes = { c: store.get('ide.code.c', SAMPLES.c), cpp: store.get('ide.code.cpp', SAMPLES.cpp) };
const editor = monaco.editor.create($('editor'), {
  value: codes[lang], language: lang, theme: 'vs-dark',
  automaticLayout: true, minimap: { enabled: false }, fontSize: 14, scrollBeyondLastLine: false,
});
editor.onDidChangeModelContent(() => { codes[lang] = editor.getValue(); store.set('ide.code.' + lang, codes[lang]); });
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run());

function fillStd() {
  $('std').innerHTML = STDS[lang].map((s) => `<option>${s}</option>`).join('');
  $('std').value = store.get('ide.std.' + lang, STDS[lang][0]);
}
$('lang').value = lang; fillStd(); $('opt').value = store.get('ide.opt', 'O0'); $('args').value = store.get('ide.args', '');
$('lang').onchange = () => {
  lang = $('lang').value; store.set('ide.lang', lang);
  monaco.editor.setModelLanguage(editor.getModel(), lang);
  editor.setValue(codes[lang]); fillStd();
};
$('std').onchange = () => store.set('ide.std.' + lang, $('std').value);
$('opt').onchange = () => store.set('ide.opt', $('opt').value);
$('args').oninput = () => store.set('ide.args', $('args').value);

// ---------- terminal ----------
const term = new Terminal({ convertEol: true, fontSize: 14, cursorBlink: true, theme: { background: '#000000' }, fontFamily: 'ui-monospace, Menlo, Consolas, monospace' });
const fit = new FitAddon(); term.loadAddon(fit); term.open($('term')); fit.fit();
new ResizeObserver(() => fit.fit()).observe($('term'));
const color = (c, s) => term.write(`\x1b[${c}m${s}\x1b[0m`);

// ---------- stdin (ring buffer in a SharedArrayBuffer: [head, tail, eof, signal] + data) ----------
const N = 65536, isolated = self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
let sab = null, ctl = null, ring = null, lineBuf = '';
function newStdin() {
  if (!isolated) return null;
  sab = new SharedArrayBuffer(16 + N); ctl = new Int32Array(sab, 0, 4); ring = new Uint8Array(sab, 16, N); return sab;
}
function pushStdin(bytes) {
  if (!ctl) return;
  let head = Atomics.load(ctl, 0); const tail = Atomics.load(ctl, 1);
  for (const b of bytes) { const next = (head + 1) % N; if (next === tail) break; ring[head] = b; head = next; }
  Atomics.store(ctl, 0, head); Atomics.add(ctl, 3, 1); Atomics.notify(ctl, 3);
}
function pushEOF() { if (!ctl) return; Atomics.store(ctl, 2, 1); Atomics.add(ctl, 3, 1); Atomics.notify(ctl, 3); }

term.onData((d) => {
  if (!runner) return;
  for (const ch of d) {
    if (ch === '\r') { term.write('\r\n'); pushStdin(new TextEncoder().encode(lineBuf + '\n')); lineBuf = ''; }
    else if (ch === '\x7f') { if (lineBuf) { lineBuf = [...lineBuf].slice(0, -1).join(''); term.write('\b \b'); } }
    else if (ch === '\x04') { if (lineBuf) { pushStdin(new TextEncoder().encode(lineBuf)); lineBuf = ''; } else pushEOF(); }
    else if (ch === '\x03') { stop('Interrupted (Ctrl+C)'); }
    else if (ch >= ' ') { lineBuf += ch; term.write(ch); }
  }
});

// ---------- compile & run ----------
const compiler = new Worker(new URL('./compiler.worker.js', import.meta.url), { type: 'module' });
let runner = null, jobId = 0;
const setStatus = (t) => ($('status').textContent = t);
const setResult = (t, cls = '') => { $('result').textContent = t; $('result').className = cls; };
const setBusy = (b) => { $('run').disabled = b; $('stop').disabled = !b; };

function compile(req) {
  const id = ++jobId;
  return new Promise((resolve) => {
    compiler.onmessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === 'progress') {
        const p = data.total ? Math.floor((100 * data.done) / data.total) : 0;
        setStatus(`Loading compiler toolchain (first run only, ~100 MB, then cached)… ${p}%`);
      } else resolve(data);
    };
    compiler.postMessage({ id, ...req });
  });
}

async function run() {
  if ($('run').disabled) return;
  setBusy(true); term.reset(); lineBuf = ''; setResult('Compiling…');
  setStatus('Compiling…');
  const res = await compile({ lang, code: editor.getValue(), std: $('std').value, opt: $('opt').value });
  if (res.diag) color(res.ok ? '33' : '31', res.diag.replace(/\r?\n/g, '\r\n'));
  if (!res.ok) { setStatus('Compilation failed'); setResult('Compilation failed.', 'err'); setBusy(false); return; }
  setStatus(`Compiled in ${(res.ms / 1000).toFixed(1)} s — running`);
  if (res.diag) term.write('\r\n');
  if (!isolated) color('90', '[page is not cross-origin isolated: stdin is disabled, reads return EOF]\r\n');

  setResult('Running…');
  const args = ['a.out', ...splitArgs($('args').value)];
  runner = new Worker(new URL('./runner.worker.js', import.meta.url), { type: 'module' });
  runner.onmessage = ({ data }) => {
    if (data.type === 'out') {
      if (data.fd === 2) term.write('\x1b[31m'); term.write(data.bytes); if (data.fd === 2) term.write('\x1b[0m');
    } else if (data.type === 'exit') {
      finish(`Return value: ${data.code}  (${data.ms.toFixed(0)} ms)`, data.code === 0 ? 'ok' : 'err');
    } else if (data.type === 'crash') {
      color('31', `\r\n[runtime error: ${data.message}]\r\n`);
      finish(`Crashed: ${data.message}`, 'err');
    }
  };
  runner.onerror = (e) => finish('Runner error: ' + e.message, 'err');
  runner.postMessage({ wasm: res.wasm, args, stdin: newStdin() }, [res.wasm.buffer]);
}

function finish(text, cls) {
  if (runner) runner.terminate(); runner = null; lineBuf = '';
  setResult(text, cls); setStatus('Idle'); setBusy(false);
  color('90', `\r\n[${text}]\r\n`);
}
function stop(msg = 'Stopped') { if (runner) finish(msg, 'err'); }

$('run').onclick = run;
$('stop').onclick = () => stop();
window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
