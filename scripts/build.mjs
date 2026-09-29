import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** 扩展宿主（Node 侧，跑在 Remote-SSH 的 Ubuntu 里） */
await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
});

/** Webview UI（浏览器侧，React 单文件 + css） */
await esbuild.build({
  entryPoints: ['src/webview/main.tsx'],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  jsx: 'automatic',
  outfile: 'dist/webview.js',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'css' },
});

console.log('[build] dist/extension.js + dist/webview.js(.css) done');
