import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });

// Endpoints and the proxy key live in config.local.json, which is git-ignored.
// Nothing internal is committed; a fresh clone starts from config.example.json.
const CONFIG_FILE = 'config.local.json';
if (!existsSync(CONFIG_FILE)) {
  console.error(
    `\nMissing ${CONFIG_FILE}.\n\n` +
    `  cp config.example.json ${CONFIG_FILE}\n\n` +
    `Then fill in proxyOrigin, proxyKey and copyStudioMcpUrl. ` +
    `See README.md for where each value comes from.\n`,
  );
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
for (const field of ['proxyOrigin', 'proxyKey', 'copyStudioMcpUrl']) {
  const v = cfg[field];
  if (typeof v !== 'string' || v === '' || v.includes('YOUR-') || v.includes('YOUR_')) {
    console.error(`\n${CONFIG_FILE}: "${field}" is missing or still a placeholder.\n`);
    process.exit(1);
  }
}

// Compiled into the bundle in place of the constants declared in src/config.ts.
const configDefine = {
  __CFG_PROXY_ORIGIN__: JSON.stringify(cfg.proxyOrigin),
  __CFG_PROXY_KEY__: JSON.stringify(cfg.proxyKey),
  __CFG_COPYSTUDIO_MCP_URL__: JSON.stringify(cfg.copyStudioMcpUrl),
};

// manifest.json is generated, not committed, so its networkAccess allowlist can
// never drift from the endpoints actually compiled into the bundle.
function buildManifest() {
  const origin = (u) => new URL(u).origin;
  const manifest = readFileSync('manifest.template.json', 'utf8')
    .replace('__COPYSTUDIO_ORIGIN__', origin(cfg.copyStudioMcpUrl))
    .replace('__PROXY_ORIGIN__', origin(cfg.proxyOrigin));
  JSON.parse(manifest); // fail loudly rather than emit a manifest Figma can't read
  writeFileSync('manifest.json', manifest);
  console.log('\u2713 manifest.json');
}

const shared = { bundle: true, platform: 'browser', target: 'es2017', logLevel: 'info' };

async function buildUI() {
  await esbuild.build({
    ...shared,
    entryPoints: ['src/ui.tsx'],
    format: 'iife',
    outfile: 'dist/_ui.js',
    jsx: 'automatic',
    minify: !watch,
    define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"', ...configDefine },
  });
  const js = readFileSync('dist/_ui.js', 'utf8');
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    html,body,#root{height:100%}
    body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#1a1a1a;background:#fff;overflow:hidden}
  </style>
</head>
<body><div id="root"></div><script>${js}</script></body>
</html>`;
  writeFileSync('dist/ui.html', html);
  console.log('✓ dist/ui.html');
}

async function buildCode() {
  await esbuild.build({
    ...shared,
    entryPoints: ['src/code.ts'],
    format: 'iife',
    outfile: 'dist/code.js',
    minify: !watch,
    define: configDefine,
    external: ['__html__'],
  });
  console.log('✓ dist/code.js');
}

if (watch) {
  const uiCtx = await esbuild.context({
    ...shared,
    entryPoints: ['src/ui.tsx'],
    format: 'iife',
    outfile: 'dist/_ui.js',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"', ...configDefine },
    plugins: [{
      name: 'on-end',
      setup(b) { b.onEnd(r => { if (r.errors.length === 0) buildUI().catch(console.error); }); },
    }],
  });
  const codeCtx = await esbuild.context({
    ...shared,
    entryPoints: ['src/code.ts'],
    format: 'iife',
    outfile: 'dist/code.js',
    define: configDefine,
    external: ['__html__'],
  });
  buildManifest();
  await Promise.all([uiCtx.watch(), codeCtx.watch()]);
  console.log('Watching…');
} else {
  buildManifest();
  await Promise.all([buildUI(), buildCode()]);
}
