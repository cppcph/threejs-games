#!/usr/bin/env node
// 在「独立网页」和「claude.ai Artifact 片段」之间互转。
//
// 仓库里的 games/<名字>/index.html 是完整网页，可以直接用静态服务器打开。
// 发布成 claude.ai Artifact 时，发布器会自己套上 <!doctype html><head><body> 骨架，
// 所以要发布的是两个标记之间的片段。
//
//   node tools/artifact.cjs unwrap games/foxfire/index.html /tmp/foxfire.fragment.html
//   node tools/artifact.cjs wrap   /tmp/foxfire.fragment.html games/foxfire/index.html
//
// 页面若用 <script type="module" src="./main.js"> 引入 ES 模块（信风、海面演示），片段里的相对 import 发布后找不到，
// 要用 tools/build-artifact.mjs 把入口和它 import 的模块打包成内联脚本。
const fs = require('fs');

const BEGIN = '<!-- ARTIFACT:BEGIN -->';
const END = '<!-- ARTIFACT:END -->';
const HEAD = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>
</head>
<body>
${BEGIN}
`;
const TAIL = `
${END}
</body>
</html>
`;

const [mode, src, dst] = process.argv.slice(2);
if (!['wrap', 'unwrap'].includes(mode) || !src || !dst) {
  console.error('usage: node tools/artifact.cjs wrap|unwrap <src> <dst>');
  process.exit(2);
}
const text = fs.readFileSync(src, 'utf8');
if (mode === 'wrap') {
  if (/^\s*<!doctype/i.test(text)) { console.error('already a full page'); process.exit(1); }
  fs.writeFileSync(dst, HEAD + text.trim() + TAIL);
} else {
  const a = text.indexOf(BEGIN), b = text.indexOf(END);
  if (a < 0 || b < 0) { console.error('markers not found'); process.exit(1); }
  fs.writeFileSync(dst, text.slice(a + BEGIN.length, b).trim() + '\n');
}
console.log(`${mode}: ${src} -> ${dst}`);
