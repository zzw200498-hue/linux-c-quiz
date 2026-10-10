/**
 * 题干切块冒烟（v0.4.3）：填空题题干里的围栏代码块必须被单独摘出来（保住换行），
 * 否则走行内渲染会把代码挤成一整行。
 * 跑法：npx esbuild scripts/selftest-stem.ts --bundle --platform=node --format=cjs --outfile=dist/selftest-stem.cjs && node dist/selftest-stem.cjs
 */
import * as fs from 'fs';
import * as path from 'path';
import { load as yamlLoad } from 'js-yaml';
import { splitLines, splitParagraphs, splitStem } from '../src/shared/stem';

let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fail++;
    console.log(`  ✗ ${name}`, extra ?? '');
  }
}

console.log('[stem] 1) 切块：文本 / 代码 交替');
const stem = [
  '以下代码的输出结果是？',
  '```c',
  '#include <stdio.h>',
  'int main() {',
  '    int a = 1;',
  '    return 0;',
  '}',
  '```',
  '输出结果：____1____',
].join('\n');
const chunks = splitStem(stem);
ok('切成 3 块（文本-代码-文本）', chunks.length === 3, chunks.map((c) => c.type));
ok('第 1 块是文本', chunks[0].type === 'text' && chunks[0].text.includes('以下代码的输出结果是？'));
ok('第 2 块是代码且带语言', chunks[1].type === 'code' && chunks[1].lang === 'c');
ok(
  '代码块保留 5 行换行（旧行为会压成 1 行）',
  chunks[1].text.split('\n').length === 5,
  chunks[1].text.split('\n').length,
);
ok('代码未丢内容', chunks[1].text.includes('#include <stdio.h>') && chunks[1].text.includes('return 0;'));
ok('第 3 块含占位符', chunks[2].type === 'text' && chunks[2].text.includes('____1____'));

console.log('[stem] 2) 边界情况');
ok('无代码块 → 单块文本', splitStem('只有一个问题？____1____').length === 1);
const unclosed = splitStem('看这段：\n```c\nint a = 1;');
ok('未闭合围栏 → 当普通文本（不丢内容）', unclosed.length === 1 && unclosed[0].type === 'text');
ok('空语言围栏也能切', splitStem('a\n```\ncode\n```\nb')[1].type === 'code');
ok('两个代码块', splitStem('a\n```c\nx\n```\nb\n```c\ny\n```').filter((c) => c.type === 'code').length === 2);

console.log('[stem] 3) 段落切分');
ok('空行分段', splitParagraphs('第一段\n第一段续\n\n第二段').length === 2);
ok('段内换行保留', splitParagraphs('第一段\n第一段续\n\n第二段')[0].split('\n').length === 2);

console.log('[stem] 3.5) 行首尾空行清理（防多余 <br>）');
ok('去掉前导空行', splitLines('\n输出结果：____1____').length === 1);
ok('去掉尾随空行', splitLines('以下代码的输出结果是？\n').length === 1);
ok('中间行保留', splitLines('a\nb').length === 2);
ok('全空 → 0 行', splitLines('\n\n').length === 0);

console.log('[stem] 4) 真实题库：填空题题干里的代码块');
const bankDir = path.join(process.cwd(), 'bank', 'bank');
let checked = 0;
let squeezed = 0;
if (fs.existsSync(bankDir)) {
  for (const name of fs.readdirSync(bankDir)) {
    if (!/\.ya?ml$/i.test(name)) continue;
    let parsed: any;
    try {
      parsed = yamlLoad(fs.readFileSync(path.join(bankDir, name), 'utf8'));
    } catch {
      continue;
    }
    for (const q of parsed?.questions ?? []) {
      if (q.type !== 'fill' || typeof q.stem !== 'string') continue;
      checked++;
      const codeChunks = splitStem(q.stem).filter((c) => c.type === 'code');
      if (codeChunks.length === 0) continue;
      // 代码块必须真的是多行（单行代码块本身没毛病，多行的才算"能读"）
      const multi = codeChunks.some((c) => c.text.split('\n').length >= 3);
      if (!multi) squeezed++;
    }
  }
  ok(`扫描了 ${checked} 道填空题，其中代码块被切出且保留换行`, squeezed === 0, `squeezed=${squeezed}`);
} else {
  console.log('  - 跳过（没找到 bank/bank 目录）');
}

console.log(fail === 0 ? '\n[stem] 全部通过' : `\n[stem] 失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
