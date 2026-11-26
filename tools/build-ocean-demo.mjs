#!/usr/bin/env node
// 把 examples/ocean（入口 main.js + ocean/ 模块）打包成单文件 claude.ai Artifact 片段。
//   node tools/build-ocean-demo.mjs <esbuild 可执行文件> <输出.html>
// 通用版本见 tools/build-artifact.mjs（任何带 ARTIFACT 标记和 ./main.js 入口的页面都能打包）。
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from './build-artifact.mjs';

const [esbuild, out] = process.argv.slice(2);
if (!esbuild || !out) { console.error('usage: node tools/build-ocean-demo.mjs <esbuild> <out.html>'); process.exit(2); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
try { buildArtifact(join(root, 'examples/ocean/index.html'), out, esbuild); } catch (e) { console.error(e.message); process.exit(1); }
