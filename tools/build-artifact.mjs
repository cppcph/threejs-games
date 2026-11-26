#!/usr/bin/env node
// 把一个“标记 + ES 模块入口”的页面打包成单文件 claude.ai Artifact 片段。
//
//   node tools/build-artifact.mjs <页面.html> <输出.html> [esbuild 可执行文件]
//   例：node tools/build-artifact.mjs games/windpost/index.html out/windpost.html node_modules/.bin/esbuild
//
// 页面约定（examples/ocean/index.html、games/windpost/index.html 都是这样写的）：
//   · 要发布的内容放在 <!-- ARTIFACT:BEGIN --> 与 <!-- ARTIFACT:END --> 之间（发布器会自己套 <html><head><body> 骨架）；
//   · 脚本入口写成 <script type="module" src="./main.js"></script>（相对路径，可以有多个）；
//   · three 与 three/addons 通过片段里的 importmap 从 CDN 加载，打包时保持外部依赖。
// 每个入口用 esbuild 打包成一个内联的 <script type="module">（入口 import 的 ../../ocean/... 等相对模块都会被打进去）。
// esbuild 可执行文件依次取：第三个参数、环境变量 ESBUILD、node_modules/.bin/esbuild。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const BEGIN = '<!-- ARTIFACT:BEGIN -->', END = '<!-- ARTIFACT:END -->';

/** 打包 pageFile，返回片段文本；out 给出时同时写文件 */
export function buildArtifact(pageFile, out, esbuild) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  esbuild = esbuild || process.env.ESBUILD || join(root, 'node_modules/.bin/esbuild');
  if (!existsSync(esbuild)) throw new Error(`找不到 esbuild：${esbuild}（npm install，或把可执行文件路径作为第三个参数）`);
  const page = readFileSync(pageFile, 'utf8');
  const a = page.indexOf(BEGIN), b = page.indexOf(END);
  if (a < 0 || b < 0) throw new Error(`${pageFile}：没找到 ${BEGIN} / ${END} 标记`);
  let frag = page.slice(a + BEGIN.length, b).trim();
  if (!/<script type="importmap">/.test(frag)) console.warn('警告：片段里没有 importmap，three 将无法加载');
  const tags = [...frag.matchAll(/<script\s+type="module"\s+src="(\.{1,2}\/[^"]+)"\s*><\/script>/g)];
  if (!tags.length) throw new Error('没找到 <script type="module" src="./…"> 入口');
  const tmp = mkdtempSync(join(tmpdir(), 'artifact-'));
  try {
    for (const [tag, src] of tags) {
      const entry = resolve(dirname(pageFile), src), bundleFile = join(tmp, 'bundle.js');
      execFileSync(esbuild, [entry, '--bundle', '--format=esm', '--minify-syntax', '--minify-whitespace',
        '--external:three', '--external:three/addons/*', '--target=es2020', '--legal-comments=none', `--outfile=${bundleFile}`], { stdio: 'inherit' });
      const bundle = readFileSync(bundleFile, 'utf8').replace(/<\/script/gi, '<\\/script');
      frag = frag.replace(tag, () => `<script type="module">\n${bundle}\n</script>`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, frag + '\n');
    console.log(`artifact fragment: ${out} (${(frag.length / 1024).toFixed(0)} KB)`);
  }
  return frag;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pageFile, out, esbuild] = process.argv.slice(2);
  if (!pageFile || !out) { console.error('usage: node tools/build-artifact.mjs <page.html> <out.html> [esbuild]'); process.exit(2); }
  try { buildArtifact(pageFile, out, esbuild); } catch (e) { console.error(e.message); process.exit(1); }
}
