#!/usr/bin/env node
// 校验 src/link-rules.js 与 preload-chat-export.js 中重复维护的链接规则是否一致 (2026-11-22 审查 M3)。
// sandbox 下 preload 无法 require 本地模块, 两份规则只能各写一份, 用本脚本防止改一边漏另一边。
// 用法: npm run check:links   (不一致时退出码为 1)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = ['src/link-rules.js', 'preload-chat-export.js'];
const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));

// 取某个函数体 (从函数名开始, 按花括号配平截取)
function fnBody(code, name) {
  const i = code.indexOf(`function ${name}(`);
  if (i < 0) return null;
  let depth = 0;
  for (let j = code.indexOf('{', i); j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}' && --depth === 0) return code.slice(i, j + 1);
  }
  return null;
}

// 只比较规则数据: 所有单引号字符串字面量的集合
const literals = (body) => new Set((body.match(/'[^'\n]*'/g) || []).map((s) => s.slice(1, -1)));

const pairs = [
  ['extractExternalTargetUrl', 'extractTargetUrl'],
  ['isShareOrDocumentUrl', 'isShareOrDocumentUrl'],
  ['isAuthOrConnectorUrl', 'isAuthOrConnectorUrl'],
];

let failed = false;
for (const [mainFn, preFn] of pairs) {
  const a = fnBody(src['src/link-rules.js'], mainFn);
  const b = fnBody(src['preload-chat-export.js'], preFn);
  if (!a || !b) { console.error(`✗ 找不到函数: link-rules.${mainFn} / preload.${preFn}`); failed = true; continue; }
  const la = literals(a), lb = literals(b);
  const onlyMain = [...la].filter((x) => !lb.has(x));
  const onlyPre = [...lb].filter((x) => !la.has(x));
  if (onlyMain.length || onlyPre.length) {
    failed = true;
    console.error(`✗ ${mainFn} 不一致`);
    if (onlyMain.length) console.error('   仅 src/link-rules.js 有:', onlyMain.join(', '));
    if (onlyPre.length) console.error('   仅 preload 有:', onlyPre.join(', '));
  } else {
    console.log(`✓ ${mainFn} 一致`);
  }
}
process.exit(failed ? 1 : 0);
