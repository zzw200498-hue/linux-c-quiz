/**
 * 生成填空题渲染预览（静态 HTML），用来核对题干代码块是否还挤成一行。
 * 渲染逻辑与 src/webview/components/FillView.tsx 保持一致。
 * 跑法：npx esbuild scripts/preview-fill.ts --bundle --platform=node --format=cjs --outfile=dist/preview-fill.cjs && node dist/preview-fill.cjs [试卷文件名] [题号]
 */
import * as fs from 'fs';
import * as path from 'path';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import { load as yamlLoad } from 'js-yaml';
import { splitLines, splitParagraphs, splitStem } from '../src/shared/stem';

const md = new MarkdownIt({ html: false, breaks: true });
md.set({
  highlight: (str: string, lang: string) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang }).value}</code></pre>`;
      } catch {
        /* fallthrough */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

const bankDir = path.join(process.cwd(), 'bank', 'bank');
const paperName = process.argv[2] ?? 'C语言综合复习试卷（第1～58节）.yaml';
const wantId = process.argv[3] ?? 'q22';

const raw = yamlLoad(fs.readFileSync(path.join(bankDir, paperName), 'utf8')) as any;
const question = (raw.questions as any[]).find((q) => q.id === wantId && q.type === 'fill');
if (!question) {
  console.error(`没找到填空题 ${wantId}`);
  process.exit(1);
}

let n = 0;
const body = splitStem(question.stem as string)
  .map((chunk) => {
    if (chunk.type === 'code') {
      return `<div class="stem-code">${md.render('```' + chunk.lang + '\n' + chunk.text + '\n```')}</div>`;
    }
    return splitParagraphs(chunk.text)
      .map((para) => {
        const lines = splitLines(para);
        const html = lines
          .map((line) => {
            if (line.trim() === '') return '';
            return line
              .split(/(____\d+____)/)
              .map((p) => {
                const m = /^____(\d+)____$/.exec(p);
                if (!m) return md.renderInline(p);
                n++;
                return `<span class="blank-wrap"><input class="blank-input" placeholder="空${m[1]}" /></span>`;
              })
              .join('');
          })
          .join('<br>');
        return `<p class="fill-para">${html}</p>`;
      })
      .join('');
  })
  .join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>填空题渲染预览 · ${question.id}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/github-dark.min.css">
<style>
body { background:#1e1e1e; color:#d4d4d4; font-family:"Microsoft YaHei",-apple-system,"Segoe UI",sans-serif; font-size:14px; line-height:1.65; padding:24px 32px; max-width:960px; }
h1 { font-size:15px; font-weight:500; color:#d4d4d4; margin:0 0 4px; }
.sub { font-size:12px; opacity:.6; margin-bottom:18px; }
.chip { display:inline-block; padding:1px 8px; border-radius:10px; border:1px solid #3c3c3c; font-size:12px; margin-right:6px; }
.stem-code { margin:8px 0; }
.stem-code pre.hljs { background:#0d1117; padding:10px 12px; border-radius:6px; overflow:auto; margin:0; }
.stem-code code, code { font-family:Consolas,"Cascadia Mono",monospace; font-size:12.5px; }
.fill-para { margin:6px 0; }
.blank-input { width:130px; background:#3c3c3c; color:#cccccc; border:1px solid #3c3c3c; border-radius:3px; padding:3px 8px; font-size:13px; }
.note { margin-top:24px; padding:10px 14px; border:1px dashed #555; border-radius:6px; font-size:12.5px; opacity:.8; line-height:1.7; }
</style></head><body>
<h1>${paperName.replace(/\.ya?ml$/, '')} · ${question.id}</h1>
<div class="sub"><span class="chip">填空</span><span class="chip">难度 ${question.difficulty ?? 1}</span>渲染逻辑与扩展内 FillView 一致</div>
<div class="stem fill-stem">${body}</div>
<div class="note">共渲染 ${n} 个空。代码块若与 YAML 里的写法一样是多行缩进，说明修复生效；挤成一整行说明还在走行内渲染。</div>
</body></html>`;

const outDir = path.join(process.cwd(), '.quiz', 'preview');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `fill-${question.id}.html`);
fs.writeFileSync(outFile, html, 'utf8');
console.log(`预览已生成：${outFile}（渲染 ${n} 个空）`);
