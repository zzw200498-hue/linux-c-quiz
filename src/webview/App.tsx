import { useCallback, useEffect, useState } from 'react';
import type { Answer, HostToWeb, InitData, Question, WebToHost } from '../shared/types';
import { TYPE_LABEL } from '../shared/types';
import { judge, isObjective } from '../shared/judge';
import { md } from './md';
import { post } from './vscode';
import { ChoiceView } from './components/ChoiceView';
import { FillView } from './components/FillView';
import { SubjectiveView } from './components/SubjectiveView';
import { CodingView } from './components/CodingView';

export function App() {
  const [data, setData] = useState<InitData | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [idx, setIdx] = useState(0);
  const [summary, setSummary] = useState<{ right: number; total: number } | null>(null);

  useEffect(() => {
    const handler = (e: MessageEvent<HostToWeb>) => {
      const m = e.data;
      if (m.type === 'init') {
        setData(m.data);
        setAnswers(m.data.answers ?? {});
        setSummary(null);
        const i = m.data.questions.findIndex((q) => q.id === m.data.startQid);
        setIdx(i >= 0 ? i : 0);
      }
    };
    window.addEventListener('message', handler);
    post({ type: 'ready' } satisfies WebToHost);
    return () => window.removeEventListener('message', handler);
  }, []);

  const save = useCallback((qid: string, value: string | string[] | null, correct: boolean | null) => {
    setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], value, correct, ts: Date.now() } }));
    post({ type: 'saveAnswer', qid, value, correct } satisfies WebToHost);
  }, []);

  /** 整卷做完后统一判定客观题（不做一题判一题） */
  const submitPaper = useCallback(() => {
    if (!data) return;
    let right = 0;
    let total = 0;
    for (const q of data.questions) {
      if (!isObjective(q)) continue;
      const v = answers[q.id]?.value ?? null;
      if (v == null) continue;
      total++;
      const c = judge(q, v) === true;
      if (c) right++;
      save(q.id, v, c);
    }
    setSummary(total > 0 ? { right, total } : null);
  }, [data, answers, save]);

  /** 清除客观题判定（保留作答，可重新刷） */
  const clearJudgement = useCallback(() => {
    if (!data) return;
    for (const q of data.questions) {
      if (!isObjective(q)) continue;
      const a = answers[q.id];
      if (a?.correct != null) save(q.id, a.value ?? null, null);
    }
    setSummary(null);
  }, [data, answers, save]);

  const copyAll = useCallback(() => {
    if (!data) return;
    const lines: string[] = [`# ${data.paperTitle} —— 我的作答`, ''];
    for (const q of data.questions) {
      const a = answers[q.id];
      const v = a?.value ?? null;
      lines.push(`## ${q.id} [${TYPE_LABEL[q.type]}]`);
      lines.push(q.stem);
      lines.push('');
      lines.push('【我的作答】');
      if (typeof v === 'string' && /[{}\n;]/.test(v)) lines.push('```', v, '```');
      else if (Array.isArray(v)) lines.push(v.join('，'));
      else lines.push(v && v.length > 0 ? v : '（未作答）');
      lines.push('');
    }
    post({ type: 'copyText', text: lines.join('\n') } satisfies WebToHost);
  }, [data, answers]);

  if (!data) return <div className="loading">加载中…</div>;

  const q: Question = data.questions[idx];
  const a = answers[q.id];
  const answeredCount = data.questions.filter((x) => {
    const v = answers[x.id]?.value;
    return v != null && (Array.isArray(v) ? v.length > 0 : v !== '');
  }).length;
  const paperJudged = data.questions.some((x) => isObjective(x) && answers[x.id]?.correct != null);
  const judged = isObjective(q) && a?.correct != null;

  return (
    <div className="quiz">
      <header className="head">
        <div className="head-title">
          <span className="paper-title">{data.paperTitle}</span>
          <span className="progress">
            {answeredCount}/{data.questions.length} 已答
          </span>
        </div>
        <div className="head-actions">
          {!paperJudged && (
            <button className="btn primary" onClick={submitPaper}>
              交卷 · 判定客观题
            </button>
          )}
          {paperJudged && (
            <button className="btn ghost" onClick={clearJudgement}>
              清除判定
            </button>
          )}
          <button className="btn ghost" onClick={copyAll}>
            复制全部作答
          </button>
        </div>
      </header>

      {summary && (
        <div className="summary">
          客观题判定完成：答对 <b>{summary.right}</b> / {summary.total}
          {summary.total > 0 && summary.right === summary.total ? ' 🎉 全对！' : ''}
          。主观题请用「导出本卷作答」交给 DeepSeek 批改。
        </div>
      )}

      <div className="chips">
        <span className="chip type">{TYPE_LABEL[q.type]}</span>
        <span className="chip">难度 {q.difficulty}</span>
        {q.tags.map((t) => (
          <span key={t} className="chip tag">
            {t}
          </span>
        ))}
      </div>

      {q.type !== 'fill' && <div className="stem" dangerouslySetInnerHTML={{ __html: md.render(q.stem) }} />}

      {q.type === 'single' || q.type === 'multi' ? (
        <ChoiceView q={q} answer={a} onSave={(v, c) => save(q.id, v, c)} />
      ) : q.type === 'fill' ? (
        <FillView q={q} answer={a} onSave={(v, c) => save(q.id, v, c)} />
      ) : q.type === 'coding' ? (
        <CodingView q={q} answer={a} onSave={(v, c) => save(q.id, v, c)} />
      ) : (
        <SubjectiveView q={q} answer={a} onSave={(v, c) => save(q.id, v, c)} />
      )}

      {judged && q.explain && (
        <div className={`explain ${a!.correct ? 'ok' : 'bad'}`}>
          <b>{a!.correct ? '✓ 回答正确' : '✗ 回答错误'}</b>
          <div dangerouslySetInnerHTML={{ __html: md.render(q.explain) }} />
        </div>
      )}

      {a?.grade && (
        <div className={`grade ${a.grade.verdict}`}>
          <b>
            批改：{a.grade.score} 分 ·{' '}
            {a.grade.verdict === 'correct' ? '正确' : a.grade.verdict === 'partial' ? '部分正确' : '错误'}
          </b>
          {a.grade.comment && <div>{a.grade.comment}</div>}
          {a.grade.missed_points.length > 0 && <div>遗漏要点：{a.grade.missed_points.join('；')}</div>}
          {a.grade.correct_answer && <div className="grade-answer">{a.grade.correct_answer}</div>}
        </div>
      )}

      <footer className="nav">
        <button className="btn" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>
          ← 上一题
        </button>
        <span className="counter">
          {idx + 1} / {data.questions.length}
        </span>
        <button
          className="btn primary"
          disabled={idx === data.questions.length - 1}
          onClick={() => setIdx(idx + 1)}
        >
          下一题 →
        </button>
      </footer>
    </div>
  );
}
