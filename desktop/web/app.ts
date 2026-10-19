import { splitStem, splitParagraphs, splitLines } from '../../src/shared/stem';
import { judge, isObjective, isEmptyAnswer, referenceAnswerLines } from '../../src/shared/judge';
import { TYPE_LABEL, type Answer, type Question } from '../../src/shared/types';
import { WRONG_STREAK_TARGET, PASS_SCORE } from '../../src/shared/wrongbook';

/* ============================ 基础工具 ============================ */

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
/** HTML 转义（拼实体时拆开字符串写，避免被当作真实标签处理） */
const esc = (s: string) =>
  s.replace(/&/g, '&' + 'amp;').replace(/</g, '&' + 'lt;').replace(/>/g, '&' + 'gt;');

/** 极简 C 语法高亮（题干代码块用，够看就行） */
function hl(code: string): string {
  const KW = ['int','char','void','long','short','unsigned','signed','float','double','if','else','for','while','do','return','break','continue','switch','case','default','struct','union','enum','typedef','static','const','sizeof','include','define','NULL'];
  return esc(code)
    .replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, '<span class="cm">$1</span>')
    .replace(/("(?:[^"\\]|\\.)*")/g, '<span class="str">$1</span>')
    .replace(new RegExp(`\\b(${KW.join('|')})\\b`, 'g'), '<span class="kw">$1</span>')
    .replace(/\b(\d+)\b/g, '<span class="num">$1</span>');
}

/** 题干/解析的轻量 Markdown：代码块 + 行内代码 + 粗体 + 段落 */
function mdLite(text: string): string {
  return text
    .split(/```[A-Za-z0-9_+#-]*\r?\n?/)
    .map((part, i) => (i % 2 === 1 ? `<pre>${hl(part.replace(/\n$/, ''))}</pre>` : inlineMd(part)))
    .join('');
}
function inlineMd(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\r?\n/g, '<br>');
}

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  if (body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await r.json()) as T;
  }
  const r = await fetch(path);
  return (await r.json()) as T;
}

function toast(msg: string) {
  let t = document.querySelector('.toast') as HTMLElement | null;
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('on');
  setTimeout(() => t!.classList.remove('on'), 1800);
}

/* ============================ 会话模型 ============================ */

type Item = {
  panelId: string;
  paper: string;
  qid: string;
  q: Question;
  answer: Answer | null;
  /**
   * 练习模式（随机刷题 / 错题本）下「本次会话」的作答。
   * 练习一律从空白开始：不回填历史答案、不显示历史判定，避免看着旧痕迹做题。
   */
  value?: string | string[] | null;
  /** 练习模式：本次判定的结果（只影响本组统计，不写回原卷） */
  lastOk?: boolean;
  /** 练习模式：本题本次自评分数 */
  selfScore?: number;
  /** 练习模式：连对次数（毕业 = 连对 3 次） */
  streak?: number;
  /** 练习模式：该题是否已过关（已过关再错一次会回炉） */
  graduated?: boolean;
  /** 练习模式：本题本次会话是否已提交判定 */
  committed?: boolean;
  /** 练习模式：是否已自主判分 */
  selfJudged?: 'pass' | 'fail';
  revealed?: boolean;
};

type Session = {
  kind: 'paper' | 'practice';
  mode?: 'wrongbook' | 'random';
  title: string;
  file?: string;
  items: Item[];
};

let session: Session | null = null;
let cur = 0;
let statsCache: any = null;

/** 试卷数据缓存：错题本一次要拼几十道题，别每题都拉一次接口 */
const paperCache = new Map<string, any>();
async function getPaper(file: string) {
  if (!paperCache.has(file)) {
    paperCache.set(file, await api(`/api/paper?file=${encodeURIComponent(file)}`));
  }
  return paperCache.get(file);
}

/* ============================ 导入新卷 ============================ */

const imp = {
  mask: $('#impMask'),
  text: $<HTMLTextAreaElement>('#impText'),
  fileInput: $<HTMLInputElement>('#impFileInput'),
  stat: $('#impStat'),
  result: $('#impResult'),
};

function impOpen() {
  imp.mask.classList.add('on');
  imp.result.style.display = 'none';
  imp.stat.textContent = '';
  imp.text.value = '';
  setTimeout(() => imp.text.focus(), 30);
}
function impClose() {
  imp.mask.classList.remove('on');
}
/** 结果提示：ok=绿色成功，bad=红色失败 */
function impResult(kind: 'ok' | 'bad', html: string) {
  imp.result.className = `imp-result ${kind}`;
  imp.result.innerHTML = html;
  imp.result.style.display = 'block';
}

function impSyncStat() {
  const v = imp.text.value.trim();
  imp.stat.textContent = v ? `${v.split('\n').length} 行 · ${v.length} 字符` : '';
}

async function impSubmit() {
  const text = imp.text.value;
  if (!text.trim()) {
    impResult('bad', '<b>还没填内容</b>把 AI 回复的整段内容粘贴进来，或者点「读取文件」。');
    return;
  }
  imp.stat.textContent = '校验中…';
  const r = await api<any>('/api/import', { text });
  impSyncStat();
  if (r.ok) {
    const warn = (r.warnings ?? []).length
      ? `<br><span style="opacity:.8">提醒：${(r.warnings as string[]).slice(0, 5).map((w) => esc(w)).join('<br>')}${
          (r.warnings as string[]).length > 5 ? `<br>…等 ${r.warnings.length} 条` : ''
        }</span>`
      : '';
    impResult(
      'ok',
      `<b>✓ 已导入《${esc(r.title)}》</b>${r.count} 题（${esc(r.summary)}）<br>落盘为 bank/${esc(r.file)}${warn}`,
    );
    toast(`已导入《${r.title}》· ${r.count} 题`);
    await loadPapers();
    setTimeout(impClose, r.warnings?.length ? 2600 : 900);
  } else if (r.stage === 'lint') {
    const list = (r.issues ?? []).slice(0, 10).map((i: string) => `<li>${esc(i)}</li>`).join('');
    impResult(
      'bad',
      `<b>${esc(r.message)}</b><ol>${list}</ol>把这段还给出题的 AI 让它补完整，或者手改后再导入。`,
    );
  } else if (r.stage === 'yaml') {
    impResult('bad', `<b>YAML 解析失败</b>${esc(r.message)}<br><br>常见原因：复制时丢了缩进，或代码块没复制完整。`);
  } else if (r.stage === 'schema') {
    const list = (r.issues ?? []).map((i: string) => `<li>${esc(i)}</li>`).join('');
    impResult(
      'bad',
      `<b>${esc(r.message)}</b>通常是字段名或类型不对（选择题必须有 choices，题号 id 不能重复…）：<ol>${list}</ol>`,
    );
  } else {
    impResult('bad', `<b>导入失败</b>${esc(r.message ?? '未知原因')}`);
  }
}

function readFileIntoInput(file: File) {
  const rd = new FileReader();
  rd.onload = () => {
    imp.text.value = String(rd.result ?? '');
    impSyncStat();
    imp.result.style.display = 'none';
  };
  rd.readAsText(file);
}

$('#btnImport').addEventListener('click', impOpen);
$('#impClose').addEventListener('click', impClose);
$('#impCancel').addEventListener('click', impClose);
$('#impGo').addEventListener('click', () => void impSubmit());
imp.mask.addEventListener('click', (e) => {
  if (e.target === imp.mask) impClose();
});
imp.text.addEventListener('input', impSyncStat);

/* 从文件读取 */
$('#impFile').addEventListener('click', () => imp.fileInput.click());
imp.fileInput.addEventListener('change', () => {
  const f = imp.fileInput.files?.[0];
  if (f) readFileIntoInput(f);
  imp.fileInput.value = '';
});

/* 拖文件进来 */
imp.text.addEventListener('dragover', (e) => {
  e.preventDefault();
  imp.text.classList.add('drag');
});
imp.text.addEventListener('dragleave', () => imp.text.classList.remove('drag'));
imp.text.addEventListener('drop', (e) => {
  e.preventDefault();
  imp.text.classList.remove('drag');
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) readFileIntoInput(f);
});

/* 从剪贴板粘贴 */
$('#impPaste').addEventListener('click', async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (!t) {
      toast('剪贴板是空的');
      return;
    }
    imp.text.value = t;
    impSyncStat();
    imp.result.style.display = 'none';
    toast('已粘贴剪贴板内容');
  } catch {
    toast('读不到剪贴板，请用 Ctrl+V 手动粘贴');
  }
});

/* 复制出题提示词 */
$('#btnCopyPrompt').addEventListener('click', async () => {
  try {
    const r = await api<any>('/api/prompt');
    if (!r.text) {
      toast(`提示词文件没找到：${r.error ?? ''}`);
      return;
    }
    await navigator.clipboard.writeText(r.text);
    toast('出题提示词已复制 → 粘给 AI（粘贴后建议把主题改一下）');
  } catch {
    toast('复制失败，请手动打开 prompts/generate.md');
  }
});

/* Ctrl/Cmd+Enter 快速导入 */
imp.text.addEventListener('keydown', (e) => {
  const ev = e as KeyboardEvent;
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
    ev.preventDefault();
    void impSubmit();
  }
  if (ev.key === 'Escape') impClose();
});

/* ============================ 页面切换 ============================ */

function showPage(name: string) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('show'));
  $(`#page-${name}`).classList.add('show');
  document.querySelectorAll('.nav-item[data-page]').forEach((n) => n.classList.toggle('active', n.getAttribute('data-page') === name));
}

document.querySelectorAll('.nav-item[data-page]').forEach((el) => {
  el.addEventListener('click', () => {
    const page = el.getAttribute('data-page')!;
    showPage(page);
    if (page === 'papers') loadPapers();
    if (page === 'wrong') loadWrongbook();
    if (page === 'stats') loadStats();
  });
});

/* ============================ 试卷列表 ============================ */

async function loadPapers() {
  const data = await api('/api/papers');
  statsCache = data.stats;
  $('#wrongCnt').textContent = String(data.stats.wrongActive);
  $('#statAcc').textContent = `正确率 ${data.stats.accuracy}%`;
  $('#statPaper').textContent = `题库 ${data.stats.paperCount} 卷 · 已作答 ${data.stats.answered}`;
  $('#footInfo').innerHTML = `题库 ${data.stats.paperCount} 卷<br>已作答 ${data.stats.answered} · 待攻克 <b style="color:var(--warn)">${data.stats.wrongActive}</b><br><span style="color:#9aa1ad">桌面端 v0.1</span>`;
  $('#randomPool').textContent = String(data.stats.answered);

  const grid = $('#paperGrid');
  grid.innerHTML = data.papers
    .map((p: any) => {
      const color = p.percent >= 80 ? 'var(--ok)' : p.percent >= 60 ? 'var(--warn)' : p.percent > 0 ? 'var(--bad)' : 'transparent';
      const border = p.percent === 0 ? '1px dashed #c9ced8' : 'none';
      const score = p.summary
        ? `<span class="score-chip ${p.summary.totalScore >= 80 ? 's-good' : p.summary.totalScore >= 60 ? 's-mid' : 's-bad'}">成绩单 ${p.summary.totalScore} 分</span>`
        : '';
      return `<div class="paper-card" data-file="${esc(p.file)}">
        <h3><span class="dotp" style="background:${color};border:${border}"></span>${esc(p.title)}</h3>
        <div class="meta"><span>${p.count} 题</span><span>${esc((p.topics ?? []).slice(0, 2).join(' · ') || '—')}</span><span>${esc(p.date || '')}</span></div>
        <div class="bar"><i style="width:${p.percent}%;background:${color === 'transparent' ? 'transparent' : color}"></i></div>
        <div class="meta"><span>完成 ${p.percent}%</span>${score}</div>
      </div>`;
    })
    .join('');
  grid.querySelectorAll('.paper-card').forEach((c) => {
    c.addEventListener('click', () => openPaper(c.getAttribute('data-file')!));
  });
}

async function openPaper(file: string) {
  const data = await api(`/api/paper?file=${encodeURIComponent(file)}`);
  session = {
    kind: 'paper',
    title: data.title,
    file: data.file,
    items: data.questions.map((q: Question) => ({ panelId: q.id, paper: file, qid: q.id, q, answer: data.answers[q.id] ?? null })),
  };
  cur = 0;
  $('#winTitle').textContent = data.title;
  showPage('quiz');
  renderQuiz();
}

/* ============================ 做题页 ============================ */

function renderQuiz() {
  if (!session) return;
  const s = session;
  const practice = s.kind === 'practice';

  // 题号网格
  $('#qnavTitle').textContent = practice ? `${s.title}` : `本卷进度 · ${s.items.length} 题`;
  $('#qGrid').innerHTML = s.items
    .map((it, i) => {
      const a = it.answer;
      let cls = '';
      if (practice) {
        // 练习模式只看本次会话：未答=灰、答了没判=浅色、判过=绿/红
        const v = it.value ?? null;
        if (it.committed) cls = it.lastOk ? 'done-ok' : 'done-bad';
        else if (!isEmptyAnswer(v)) cls = 'done';
      } else {
        cls = a?.correct === true ? 'done-ok' : a?.correct === false ? 'done-bad' : '';
      }
      return `<div class="qcell ${cls} ${i === cur ? 'cur' : ''}" data-i="${i}">${i + 1}</div>`;
    })
    .join('');
  $('#qGrid').querySelectorAll('.qcell').forEach((c) =>
    c.addEventListener('click', () => {
      cur = Number(c.getAttribute('data-i'));
      renderQuiz();
      $('.qmain').scrollTo(0, 0);
    }),
  );

  let ok: number, bad: number;
  if (practice) {
    ok = s.items.filter((i) => i.committed && i.lastOk).length;
    bad = s.items.filter((i) => i.committed && !i.lastOk).length;
  } else {
    ok = s.items.filter((i) => i.answer?.correct === true).length;
    bad = s.items.filter((i) => i.answer?.correct === false).length;
  }
  $('#lgOk').textContent = String(ok);
  $('#lgBad').textContent = String(bad);
  $('#lgNone').textContent = String(s.items.length - ok - bad);

  // 侧栏操作
  const acts = $('#qActions');
  acts.innerHTML = practice
    ? `<button class="btn ghost" id="btnExitPractice">结束本组</button>`
    : `<button class="btn primary" id="btnSubmit">交卷 · 判定客观题</button>
       <button class="btn ghost" id="btnClear">清除判定</button>`;
  if (!practice) {
    $('#btnSubmit').addEventListener('click', async () => {
      const r = await api('/api/submit', { file: s.file });
      toast(`已判 ${r.total} 道客观题 · 对 ${r.right} 道 · 成绩 ${r.summary?.totalScore ?? '—'} 分`);
      await reloadSessionAnswers();
      renderQuiz();
    });
    $('#btnClear').addEventListener('click', async () => {
      await api('/api/clear', { file: s.file });
      await reloadSessionAnswers();
      renderQuiz();
    });
  } else {
    $('#btnExitPractice').addEventListener('click', () => showPage(s.mode === 'random' ? 'random' : 'wrong'));
  }

  // 题目主体（渲染出错时把错误显示出来，别静默成空白页）
  try {
    $('#qMain').innerHTML = s.items.map((it, i) => (i === cur ? questionHtml(it, i) : '')).join('');
    bindQuestion(s.items[cur]);
  } catch (e) {
    const err = e as Error;
    $('#qMain').innerHTML = `<div class="qcard"><b style="color:var(--bad)">这一题渲染失败</b><br><pre style="white-space:pre-wrap;font-size:12px;margin-top:8px">${esc(err.message)}\n${esc(err.stack ?? '')}</pre></div>`;
    console.error('[quiz] 渲染题目失败', e);
  }
}

async function reloadSessionAnswers() {
  if (!session) return;
  if (session.kind === 'paper') {
    const data = await api(`/api/paper?file=${encodeURIComponent(session.file!)}`);
    session.items = session.items.map((it) => ({ ...it, answer: data.answers[it.qid] ?? null }));
  }
}

/** 单题渲染 */
function questionHtml(it: Item, idx: number): string {
  const q = it.q;
  const practice = session!.kind === 'practice';
  const a = it.answer;
  // 练习模式：忽略历史作答/批改，从空白开始（历史答案会剧透，尤其是"之前答对了"）
  const value = practice ? (it.value ?? null) : (a?.value ?? null);
  const judged = practice ? !!it.committed || !!it.selfJudged : a?.correct != null;

  const head = `<div class="qhead">
      <span class="qtype">${TYPE_LABEL[q.type] ?? q.type}</span>
      <span style="font-size:11px;color:var(--text2)">第 ${idx + 1} 题</span>
      ${(q.tags ?? []).slice(0, 3).map((t) => `<span class="qtype" style="background:var(--bg);color:var(--text2)">${esc(t)}</span>`).join('')}
      <span class="qscore">${practice ? esc(it.paper.replace('.yaml', '')) : ''}</span>
    </div>`;

  let body = '';

  if (q.type === 'single' || q.type === 'multi') {
    const sel = Array.isArray(value) ? value : value ? [value] : [];
    body += `<div class="stem">${stemHtml(q.stem, null)}</div><div class="opts">`;
    (q.choices ?? []).forEach((c, i) => {
      const letter = 'ABCDEFGH'[i];
      const isSel = sel.includes(letter);
      let cls = isSel ? 'sel' : '';
      if (judged) {
        const right = (q.answer ?? []).includes(letter);
        if (right) cls = 'right';
        else if (isSel) cls = 'wrong';
      }
      body += `<div class="opt ${cls}" data-letter="${letter}"><span class="letter">${letter}</span><span>${inlineMd(c)}</span></div>`;
    });
    body += `</div>`;
  } else if (q.type === 'fill') {
    body += `<div class="stem">${stemHtml(q.stem, value, judged)}</div>`;
  } else if (q.type === 'coding') {
    body += `<div class="stem">${stemHtml(q.stem, null)}</div>
      <div class="editor-box">
        <div class="editor-head"><span class="fname" id="edName">main.c</span><span class="spacer"></span>
          <span id="edHint" style="font-size:11px"></span>
          <button class="runbtn" id="btnRun">▶ 运行测试</button></div>
        <div id="monacoHost"></div>
      </div>
      <div class="terminal" id="term" style="display:none"></div>`;
  } else {
    body += `<div class="stem">${stemHtml(q.stem, null)}</div>
      <textarea class="subject-input" id="subjInput" placeholder="在这里写你的答案…">${esc(typeof value === 'string' ? value : Array.isArray(value) ? value.join('\n') : '')}</textarea>`;
  }

  // 判定结果 / 解析
  if (judged && !practice && q.explain) {
    body += `<div class="explain"><b>解析：</b>${mdLite(q.explain)}</div>`;
  }
  // 历史批改/自评只在正式卷里显示；练习模式若显示"批改：100 分"等于直接告诉你上次答对了
  if (a?.grade && !practice) {
    const g = a.grade;
    body += `<div class="explain"><b>${g.source === 'self' ? '自评' : '批改'}：${g.score} 分 · ${g.verdict === 'correct' ? '正确' : g.verdict === 'partial' ? '部分正确' : '错误'}</b>${g.comment ? `<br>${esc(g.comment)}` : ''}</div>`;
  }
  if (practice && it.selfScore != null) {
    body += `<div class="explain"><b>本次自评：${it.selfScore} 分${it.selfScore >= PASS_SCORE ? '（记为一次连对）' : '（打回待攻克）'}</b></div>`;
  }

  // 练习模式：连对进度 + 自主判分 / 自行打分
  if (practice) {
    const dots = [0, 1, 2]
      .map((i) => `<i class="${i < (it.streak ?? 0) ? 'on' : ''}"></i>`)
      .join('');
    body = `<div class="drill-bar">
        <span class="chip">${session!.mode === 'random' ? '随机刷题' : '错题本 · 待攻克'}</span>
        <span class="streak-dots">${dots}</span>
        <span class="hint">连对 ${it.streak ?? 0} / ${WRONG_STREAK_TARGET} 次毕业${it.graduated ? ' · 已过关，再错一次回炉' : ''}</span>
      </div>` + body;
    body += `<div class="selfjudge">
      <span class="sj-title">${isObjective(q) ? '自主判分（以你的判断为准）' : '主观题：先看参考答案，再自评'}：</span>
      <button class="chipbtn" id="btnReveal">查看参考答案</button>
      <button class="chipbtn" id="btnPass">✓ 我算对（计入连对）</button>
      <button class="chipbtn" id="btnFail">✗ 我算错（打回）</button>
      ${isObjective(q) ? '<button class="chipbtn" id="btnAuto">提交并判定（自动）</button>' : ''}
    </div>
    <div id="revealBox"></div>`;
    if (!isObjective(q)) {
      body += `<div class="selfgrade">
        <span class="sj-title">自行打分：</span>
        <input type="number" id="sgInput" min="0" max="100" placeholder="0-100">
        <button class="chipbtn" data-sg="100">全对 100</button>
        <button class="chipbtn" data-sg="80">80</button>
        <button class="chipbtn" data-sg="${PASS_SCORE}">及格 ${PASS_SCORE}</button>
        <button class="chipbtn" data-sg="40">40</button>
        <button class="chipbtn" data-sg="0">不会 0</button>
        <span class="sj-title">（≥${PASS_SCORE} 记一次连对，连对 ${WRONG_STREAK_TARGET} 次毕业）</span>
      </div>`;
    }
  }

  // 操作区
  body += `<div class="actions" id="qAct">`;
  if (!practice && !judged && isObjective(q)) {
    body += `<span class="sj-title">客观题：保存后不立即判分，整卷交卷时统一判定</span>`;
  }
  if (judged && q.explain && !practice) body += `<span class="verdict ${a?.correct === true ? 'v-ok' : 'v-bad'}">${a?.correct === true ? '✓ 回答正确' : '✗ 回答错误'}</span>`;
  if (it.committed && practice) {
    const ok = it.selfJudged ? it.selfJudged === 'pass' : judge(q, value) === true;
    body += `<span class="verdict ${ok ? 'v-ok' : 'v-bad'}">${ok ? '✓ 本次判定：对' : '✗ 本次判定：错'}</span>`;
  }
  body += `</div>`;

  return `<div class="qcard">${head}${body}</div>`;
}

/** 题干渲染：代码块保住换行，填空题 ____N____ 处插输入框 */
function stemHtml(stem: string, value: string | string[] | null, judged = false): string {
  const vals = Array.isArray(value) ? value : value ? [value] : [];
  let out = '';
  for (const chunk of splitStem(stem)) {
    if (chunk.type === 'code') {
      out += `<pre>${hl(chunk.text)}</pre>`;
      continue;
    }
    for (const para of splitParagraphs(chunk.text)) {
      const lines = splitLines(para);
      out += `<p>${lines
        .map((line) =>
          line
            .split(/(____\d+____)/)
            .map((seg) => {
              const m = /^____(\d+)____$/.exec(seg);
              if (!m) return inlineMd(seg);
              const bi = Number(m[1]) - 1;
              const v = vals[bi] ?? '';
              return `<input class="blank-input" data-blank="${bi}" type="text" value="${esc(v)}" placeholder="空${bi + 1}">`;
            })
            .join(''),
        )
        .join('<br>')}</p>`;
    }
  }
  void judged;
  return out;
}

/* ---------- 交互绑定 ---------- */

let monacoReady = false;
let editor: any = null;

function ensureMonaco(cb: () => void) {
  const anyWin = window as any;
  if (monacoReady) return cb();
  if (!anyWin.require) {
    // Monaco 没加载成功 → 用 textarea 兜底
    const host = $('#monacoHost');
    if (host) host.innerHTML = `<textarea class="editor-fallback" id="codeFallback"></textarea>`;
    monacoReady = true;
    return cb();
  }
  anyWin.require.config({ paths: { vs: '/monaco/vs' } });
  anyWin.require(['vs/editor/editor.main'], () => {
    monacoReady = true;
    registerCompletions(anyWin.monaco);
    cb();
  });
}

/** 给 Monaco 挂一个 C 语言补全（关键字 + 常用 POSIX 函数 + 头文件） */
function registerCompletions(monaco: any) {
  const KW = ['int','char','void','long','short','unsigned','signed','float','double','if','else','for','while','do','return','break','continue','switch','case','default','struct','union','enum','typedef','static','const','sizeof','volatile','extern','goto'];
  const FN = ['printf','fprintf','sprintf','snprintf','scanf','malloc','calloc','realloc','free','memcpy','memset','strcmp','strcpy','strlen','strdup','strerror','perror','fopen','fclose','fread','fwrite','fgets','fputs','open','close','read','write','lseek','fork','execl','execvp','wait','waitpid','exit','pipe','dup2','mmap','munmap','pthread_create','pthread_join','pthread_mutex_init','pthread_mutex_lock','pthread_mutex_unlock','pthread_cond_init','pthread_cond_wait','pthread_cond_signal','sleep','usleep','getpid','getppid','signal','kill','opendir','readdir','stat','unlink','rename','select','poll','socket','bind','listen','accept','connect','send','recv','htons','inet_addr','fcntl','ioctl','time','clock_gettime','qsort','bsearch','atoi','atof','strtol','isalpha','isdigit','tolower','toupper'];
  const HEADERS = ['stdio.h','stdlib.h','string.h','unistd.h','fcntl.h','errno.h','pthread.h','sys/types.h','sys/stat.h','sys/wait.h','sys/mman.h','sys/socket.h','sys/select.h','sys/epoll.h','dirent.h','signal.h','time.h','stdint.h','stddef.h','arpa/inet.h','netinet/in.h'];
  const mk = (list: string[], kind: any) =>
    list.map((w) => ({ label: w, kind, insertText: w }));
  monaco.languages.registerCompletionItemProvider('c', {
    provideCompletionItems: () => ({
      suggestions: [
        ...mk(KW, monaco.languages.CompletionItemKind.Keyword),
        ...mk(FN, monaco.languages.CompletionItemKind.Function),
        ...mk(HEADERS, monaco.languages.CompletionItemKind.Module),
      ],
    }),
  });
}

async function bindQuestion(it: Item) {
  if (!it || !session) return;
  const q = it.q;
  const practice = session.kind === 'practice';

  /* 单选 / 多选 */
  const opts = document.querySelectorAll('.opt');
  if (opts.length > 0) {
    // 练习模式只认本次会话点选的，不回填历史选项
    const init = practice ? (it.value ?? null) : (it.answer?.value ?? null);
    const sel = new Set<string>(Array.isArray(init) ? init : init ? [init] : []);
    opts.forEach((o) => {
      const letter = o.getAttribute('data-letter')!;
      if (sel.has(letter)) o.classList.add('sel');
      o.addEventListener('click', async () => {
        if (practice && it.committed) return;
        if (q.type === 'single') {
          sel.clear();
          sel.add(letter);
        } else if (sel.has(letter)) sel.delete(letter);
        else sel.add(letter);
        const v = q.type === 'single' ? letter : [...sel];
        await saveValue(it, v);
        if (practice && q.type === 'single') {
          const ok = judge(q, v) === true;
          it.committed = true;
          it.lastOk = ok;
          const r = await api<any>('/api/practice', { paper: it.paper, qid: it.qid, ok });
          if (r?.entry) {
            it.streak = r.entry.streak;
            it.graduated = r.entry.passed;
          }
        }
        renderQuiz();
      });
    });
  }

  /* 填空：输入只保存，练习模式点「提交并判定」才结算 */
  const blanks = document.querySelectorAll<HTMLInputElement>('.blank-input');
  if (blanks.length > 0) {
    const vals: string[] = [];
    blanks.forEach((b) => vals[Number(b.getAttribute('data-blank'))] = b.value);
    blanks.forEach((b) => {
      b.addEventListener('change', async () => {
        const next = [...vals];
        next[Number(b.getAttribute('data-blank'))] = b.value;
        await saveValue(it, next);
        toast('已保存（未判定）');
      });
    });
  }

  /* 简答 / 改写 */
  const subj = $<HTMLTextAreaElement>('#subjInput');
  if (subj) {
    subj.addEventListener('change', () => saveValue(it, subj.value));
  }

  /* 编程题：Monaco */
  if (q.type === 'coding') {
    ensureMonaco(async () => {
      const info = await api<any>(`/api/code?file=${encodeURIComponent(it.paper)}&qid=${encodeURIComponent(it.qid)}`);
      const nameEl = $('#edName');
      if (nameEl) nameEl.textContent = info.entryName;
      const hintEl = $('#edHint');
      if (hintEl && info.dir) hintEl.textContent = `目录：…/${info.dir.split(/[\\/]/).slice(-2).join('/')}`;
      const anyWin = window as any;
      if (anyWin.monaco) {
        const host = $('#monacoHost');
        if (editor) {
          editor.dispose();
          editor = null;
        }
        host.innerHTML = '';
        editor = anyWin.monaco.editor.create(host, {
          value: info.code ?? '',
          language: info.lang === 'cpp' ? 'cpp' : info.lang === 'makefile' ? 'plaintext' : 'c',
          theme: 'vs-dark',
          fontSize: 13,
          fontFamily: 'Consolas, monospace',
          minimap: { enabled: false },
          automaticLayout: true,
          scrollBeyondLastLine: false,
          tabSize: 4,
        });
        editor.onDidChangeModelContent(() => {
          clearTimeout((editor as any)._t);
          (editor as any)._t = setTimeout(() => {
            void api('/api/code', {
            file: it.paper,
            qid: it.qid,
            code: editor.getValue(),
            keepJudgement: session?.kind === 'practice',
          });
          }, 800);
        });
      } else {
        const fb = $<HTMLTextAreaElement>('#codeFallback');
        if (fb) {
          fb.value = info.code ?? '';
          fb.addEventListener('change', () =>
            api('/api/code', {
              file: it.paper,
              qid: it.qid,
              code: fb.value,
              keepJudgement: session?.kind === 'practice',
            }),
          );
        }
      }
    });
    const runBtn = $('#btnRun');
    if (runBtn) runBtn.addEventListener('click', () => runCode(it));
  }

  /* 练习模式：自主判分 / 参考答案 / 自评 */
  const btnReveal = $('#btnReveal');
  if (btnReveal) {
    btnReveal.addEventListener('click', () => {
      const box = $('#revealBox');
      if (!box) return;
      const lines = referenceAnswerLines(q);
      box.innerHTML = `<div class="reveal"><b>参考答案：</b><br>${lines.map((l) => esc(l)).join('<br>')}</div>`;
    });
  }
  const bindJudge = (id: string, pass: boolean | null) => {
    const el = $(`#${id}`);
    if (!el) return;
    el.addEventListener('click', async () => {
      const ok = pass === null ? judge(q, it.value ?? null) === true : pass;
      it.committed = true;
      it.lastOk = ok;
      it.selfJudged = pass === null ? undefined : pass ? 'pass' : 'fail';
      await saveValue(it, it.value ?? null);
      const r = await api<any>('/api/practice', { paper: it.paper, qid: it.qid, ok });
      if (r?.entry) {
        it.streak = r.entry.streak;
        it.graduated = r.entry.passed;
      }
      toast(ok ? '✓ 记一次连对' : '✗ 打回待攻克');
      renderQuiz();
    });
  };
  bindJudge('btnPass', true);
  bindJudge('btnFail', false);
  bindJudge('btnAuto', null);

  document.querySelectorAll<HTMLElement>('[data-sg]').forEach((b) =>
    b.addEventListener('click', async () => {
      const score = Number(b.getAttribute('data-sg'));
      it.committed = true;
      it.selfScore = score;
      it.lastOk = score >= PASS_SCORE;
      const r = await api<any>('/api/selfgrade', { paper: it.paper, qid: it.qid, score });
      if (r?.entry) {
        it.streak = r.entry.streak;
        it.graduated = r.entry.passed;
      }
      toast(score >= PASS_SCORE ? `自评 ${score} 分 · 记一次连对` : `自评 ${score} 分 · 打回待攻克`);
      renderQuiz();
    }),
  );
  const sgInput = $<HTMLInputElement>('#sgInput');
  if (sgInput) {
    sgInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      const score = Number(sgInput.value);
      it.committed = true;
      it.selfScore = score;
      it.lastOk = score >= PASS_SCORE;
      void api('/api/selfgrade', { paper: it.paper, qid: it.qid, score }).then(() => renderQuiz());
    });
  }
}

async function saveValue(it: Item, v: string | string[] | null) {
  const practice = session?.kind === 'practice';
  // 练习模式要保留原卷的历史判定/批改，不能因为重做一次就把 correct 抹成 null
  await api('/api/answer', {
    file: it.paper,
    qid: it.qid,
    value: v,
    correct: null,
    keepJudgement: !!practice,
  });
  paperCache.delete(it.paper);
  const st = await getPaper(it.paper);
  it.answer = st.answers[it.qid] ?? null;
  if (practice) it.value = v;
}

async function runCode(it: Item) {
  const term = $('#term');
  if (!term) return;
  term.style.display = 'block';
  term.innerHTML = `<span class="t-cmd">$ 同步到 VM → 编译 → 运行用例…</span>`;
  const code = editor ? editor.getValue() : ($<HTMLTextAreaElement>('#codeFallback')?.value ?? '');
  const r = await api<any>('/api/run', {
    file: it.paper,
    qid: it.qid,
    code,
    keepJudgement: session?.kind === 'practice',
  });
  if (r.error) {
    term.innerHTML = `<span class="t-err">${esc(r.error)}</span>`;
    return;
  }
  let html = '';
  if (r.compile) {
    html += `<span class="t-cmd">$ ${esc(r.compile.cmd)}</span>\n`;
    if (r.compile.ok) html += `<span class="t-ok">[quiz] 编译通过</span>\n`;
    else html += `<span class="t-err">${esc(r.compile.output || '编译失败')}</span>\n`;
  }
  html += `<span class="t-ok">[quiz] 用例 ${r.passed}/${r.total} 通过</span>\n`;
  for (const t of r.tests ?? []) {
    html += `${t.passed ? '<span class="t-ok">✔</span>' : '<span class="t-err">✘</span>'} ${esc(t.name)}`;
    if (!t.passed) {
      if (t.timedOut) html += ` （超时）`;
      if (t.stdout?.trim()) html += `\n  输出：${esc(t.stdout.trim().slice(0, 200))}`;
      if (t.expected?.trim()) html += `\n  期望：${esc(t.expected.trim().slice(0, 200))}`;
      if (t.stderr?.trim()) html += `\n  错误：${esc(t.stderr.trim().slice(0, 200))}`;
    }
    html += `\n`;
  }
  if (r.error) html += `<span class="t-err">${esc(r.error)}</span>`;
  term.innerHTML = html;
}

/* ============================ 随机刷题 ============================ */

$('#btnStartRandom').addEventListener('click', async () => {
  const set = await api<any>('/api/random');
  if (!set.questions?.length) {
    toast('抽题池是空的：先做几张卷子');
    return;
  }
  session = {
    kind: 'practice',
    mode: 'random',
    title: set.title,
    items: set.questions.map((q: any) => {
      const src = set.source[q.id];
      return { panelId: q.id, paper: src.paper, qid: src.qid, q: { ...q, id: q.id }, answer: set.answers[q.id] ?? null };
    }),
  };
  cur = 0;
  $('#winTitle').textContent = '随机刷题';
  showPage('quiz');
  renderQuiz();
});

/* ============================ 错题本 ============================ */

let wrongKind: 'active' | 'passed' = 'active';
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    wrongKind = t.getAttribute('data-kind') as 'active' | 'passed';
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
    loadWrongbook();
  }),
);

async function loadWrongbook() {
  const data = await api<any>(`/api/wrongbook?kind=${wrongKind}`);
  const list = $('#wrongList');
  if (!data.items.length) {
    list.innerHTML = `<div class="empty">${wrongKind === 'active' ? '还没有待攻克的错题。' : '还没有过关的题：连续答对 3 次即毕业。'}</div>`;
    return;
  }
  list.innerHTML = `<h4>${wrongKind === 'active' ? '待攻克' : '已过关'}（${data.items.length}）</h4>` +
    data.items
      .map((it: any) => {
        const dots = [0, 1, 2]
          .map((i) => `<i class="${i < it.streak ? (wrongKind === 'passed' ? 'done' : 'on') : ''}"></i>`)
          .join('');
        const type = TYPE_LABEL[it.type as keyof typeof TYPE_LABEL] ?? it.type;
        return `<div class="wrong-item" data-key="${esc(it.key)}">
          <div class="streak-dots">${dots}</div>
          <span class="qtype" style="font-size:10px">${type}</span>
          <div class="wq">${esc(it.stem)}</div>
          <div class="wsrc">${esc(it.paperFile.replace('.yaml', ''))}</div>
        </div>`;
      })
      .join('');
  list.querySelectorAll('.wrong-item').forEach((el) =>
    el.addEventListener('click', () => startWrongbookDrill(el.getAttribute('data-key')!)),
  );
}

async function startWrongbookDrill(key: string) {
  const data = await api<any>(`/api/wrongbook?kind=${wrongKind}`);
  const items = data.items.map((it: any) => it);
  const startIdx = items.findIndex((i: any) => i.key === key);
  const order = [...items.slice(startIdx < 0 ? 0 : startIdx), ...items.slice(0, startIdx < 0 ? 0 : startIdx)];

  const loaded: Item[] = [];
  for (const it of order) {
    const p = await getPaper(it.paperFile);
    const q = p.questions.find((x: Question) => x.id === it.qid);
    if (!q) continue;
    loaded.push({
      panelId: it.key,
      paper: it.paperFile,
      qid: it.qid,
      q: { ...q, id: it.key },
      answer: p.answers[it.qid] ?? null,
      streak: it.streak ?? 0,
      graduated: wrongKind === 'passed',
    });
  }
  session = { kind: 'practice', mode: 'wrongbook', title: `错题本 · 待攻克（${loaded.length}）`, items: loaded };
  cur = 0;
  $('#winTitle').textContent = '错题本';
  showPage('quiz');
  renderQuiz();
}

/* ============================ 统计 ============================ */

async function loadStats() {
  const s = await api<any>('/api/stats');
  $('#statGrid').innerHTML = `
    <div class="stat-card"><div class="num">${s.answered}</div><div class="lbl">累计作答</div></div>
    <div class="stat-card"><div class="num" style="color:var(--ok)">${s.accuracy}%</div><div class="lbl">总体正确率</div></div>
    <div class="stat-card"><div class="num" style="color:var(--warn)">${s.wrongActive}</div><div class="lbl">错题本待攻克</div></div>
    <div class="stat-card"><div class="num" style="color:var(--accent)">${s.wrongPassed}</div><div class="lbl">已过关</div></div>`;

  $('#tagList').innerHTML = s.weakTags.length
    ? s.weakTags
        .map((t: any) => {
          const pct = Math.round(t.rate * 100);
          const color = pct >= 50 ? 'var(--bad)' : pct >= 30 ? 'var(--warn)' : 'var(--ok)';
          return `<div class="tagrow"><div class="tname">${esc(t.tag)}</div>
            <div class="tbar"><i style="width:${Math.max(pct, 4)}%;background:${color}"></i></div>
            <div class="tpct" style="color:${color}">错误 ${pct}%</div></div>`;
        })
        .join('')
    : `<div class="empty">还没有足够的作答数据（知识点需被答过 3 次以上才统计）</div>`;

  const max = Math.max(1, ...s.days.map((d: any) => d.n));
  $('#dayBars').innerHTML = s.days
    .map((d: any) => `<div class="b"><i style="height:${Math.round((d.n / max) * 100)}%"></i><span>${d.label}<br>${d.n}</span></div>`)
    .join('');
}

/* ============================ 启动 ============================ */

(async function boot() {
  await loadPapers();
  const cfg = await api<any>('/api/config');
  const badge = $('#runnerBadge');
  if (cfg.runner === 'ssh' && cfg.sshHost) {
    const probe = await api<any>('/api/ssh');
    if (probe.ok) {
      badge.textContent = `● Runner 已连接（ssh ${cfg.sshHost}）`;
      badge.classList.add('on');
    } else {
      badge.textContent = `● ssh 未连通（${cfg.sshHost}）`;
      badge.classList.add('off');
    }
  } else {
    badge.textContent = `● Runner：${cfg.runner}`;
  }

  // Electron 壳：红黄绿灯接窗口控制、标题栏可拖动、页脚显示当前题库目录
  const ea = (window as any).electronAPI as
    | { isElectron: boolean; min(): void; max(): void; close(): void; ws(): Promise<string> }
    | undefined;
  if (ea?.isElectron) {
    document.body.classList.add('electron');
    $('#tlClose')?.addEventListener('click', () => ea.close());
    $('#tlMin')?.addEventListener('click', () => ea.min());
    $('#tlMax')?.addEventListener('click', () => ea.max());
    void ea
      .ws()
      .then((ws: string) => {
        const short = ws.split(/[\\/]/).slice(-2).join('/');
        const foot = $('#footInfo');
        if (foot) foot.innerHTML += `<br><span style="color:#9aa1ad" title="${esc(ws)}">题库 …${esc(short)}</span>`;
        badge.title = `题库目录：${ws}`;
      })
      .catch(() => undefined);
  }
})();

void statsCache;
