#!/usr/bin/env node
// 把 examples/ocean（入口 main.js + ocean/ 模块）打包成单文件 claude.ai Artifact 片段。
//   node tools/build-ocean-demo.mjs <esbuild 可执行文件> <输出.html>
// three 与 three/addons 保持外部依赖（运行时由页面里的 importmap 从 jsDelivr 加载）。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const [esbuild, out] = process.argv.slice(2);
if (!esbuild || !out) { console.error('usage: node tools/build-ocean-demo.mjs <esbuild> <out.html>'); process.exit(2); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = join(mkdtempSync(join(tmpdir(), 'windsea-')), 'bundle.js');
execFileSync(esbuild, [join(root, 'examples/ocean/main.js'), '--bundle', '--format=esm', '--minify-syntax', '--minify-whitespace',
  '--external:three', '--external:three/addons/*', '--target=es2020', `--outfile=${tmp}`], { stdio: 'inherit' });
const bundle = readFileSync(tmp, 'utf8').replace(/<\/script/gi, '<\\/script');
const page = readFileSync(join(root, 'examples/ocean/index.html'), 'utf8');
const a = page.indexOf('<!-- ARTIFACT:BEGIN -->'), b = page.indexOf('<!-- ARTIFACT:END -->');
let frag = page.slice(a + '<!-- ARTIFACT:BEGIN -->'.length, b).trim();
const tag = '<script type="module" src="./main.js"></script>';
if (!frag.includes(tag)) throw new Error('入口 script 标签没找到');
frag = frag.replace(tag, `<script type="module">\n${bundle}\n</script>`);
writeFileSync(out, frag + '\n');
console.log(`artifact fragment: ${out} (${(frag.length / 1024).toFixed(0)} KB)`);
