# WASM C/C++ IDE

An OnlineGDB-style mini IDE that runs **entirely in the browser** (no server-side compiling):

- **Compiler**: Clang + LLD built for WebAssembly (`@yowasp/clang`, includes wasi-libc + libc++), runs in a Web Worker.
- **Runtime**: the produced `wasm32-wasi` binary runs in a second Web Worker with a tiny custom WASI host (`src/wasi.js`).
- **Editor**: Monaco. **Terminal**: xterm.js with interactive stdin. Command-line args field, return value display, C / C++ selector, standard and -O level.

## Run
```
npm install
npm run dev        # open the printed http://localhost:5173
```
Production: `npm run build`; serve the contents of `dist/` from any static web host over HTTP(S).
`npm run preview` is available for a local production-build check. The relative asset paths also
support hosting under a repository subpath, as on GitHub project pages.

### GitHub Pages (no workflow)

1. Run `npm run build`.
2. Copy the build output into a `docs/` folder in the repository: `mkdir -p docs && cp -R dist/. docs/`.
3. Commit the `docs/` contents, then in **Settings → Pages**, choose **Deploy from a branch**, select your branch and `/docs`.

GitHub Pages does not let a site configure the `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` headers required for `SharedArrayBuffer`. The IDE still compiles and
runs programs there, but interactive stdin is unavailable and reads return EOF. A static host that
lets you set both headers enables interactive stdin.

The first compile downloads the ~100 MB toolchain (then browser-cached); later compiles take ~1-5 s.

## Files
- `src/main.js` UI, Monaco, terminal, stdin ring buffer, run/stop
- `src/compiler.worker.js` runs clang/clang++ (persistent worker)
- `src/runner.worker.js` + `src/wasi.js` executes the program (new worker per run; Stop = terminate)

## Limitations
- C++ is compiled with `-fno-exceptions` (the bundled libc++ has no exception support), so `try/catch`/`throw` won't compile.
- No threads, sockets, or filesystem (stdin/stdout/stderr only).
- stdout is made unbuffered (via an injected constructor) so prompts appear before input is requested.
