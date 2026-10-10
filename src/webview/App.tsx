import { useCallback, useEffect, useState } from 'react';
import type { Answer, HostToWeb, InitData, PaperSummary, Question, WebToHost } from '../shared/types';
import { TYPE_LABEL } from '../shared/types';
import { autoOverallText } from '../shared/summary';
import { WRONG_STREAK_TARGET } from '../shared/wrongbook';
import { isEmptyAnswer, judge, isObjective, referenceAnswerLines } from '../shared/judge';
import { md } from './md';
import { post } from './vscode';
import { ChoiceView } from './components/ChoiceView';
import { FillView } from './components/FillView';
import { SubjectiveView } from './components/SubjectiveView';
import { CodingView } from './components/CodingView';
import { SelfGrade } from './components/SelfGrade';

export function App() {
  const [data, setData] = useState<InitData | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [idx, setIdx] = useState(0);
  const [summary, setSummary] = useState<{ right: number; total: number } | null>(null);
  const [report, setReport] = useState<PaperSummary | null>(null);
  const [streaks, setStreaks] = useState<Record<string, { streak: number; passed: boolean }>>({});
  const [graduated, setGraduated] = useState<string | null>(null);
  /** 错题本刷题：本次会话里已点「提交并判定」的题（判定前不显示对错、不锁定选项） */
  const [committed, setCommitted] = useState<Record<string, boolean>>({});
  /** 错题本刷题：已展开参考答案的题（只看答案、不计分） */
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  /** 错题本刷题：客观题自评结果（答案写法多样时自己判对错） */
  const [selfJudged, setSelfJudged] = useState<Record<string, 'pass' | 'fail'>>({});

  useEffect(() => {
    const handler = (e: MessageEvent<HostToWeb>) => {
      const m = e.data;
      if (m.type === 'init') {
        setData(m.data);
        setAnswers(m.data.answers ?? {});
        setSummary(null);
        setReport(m.data.summary);
        setStreaks(m.data.wrongbook?.progress ?? {});
        setCommitted({});
        setRevealed({});
        setSelfJudged({});
        setGraduated(null);
        const i = m.data.questions.findIndex((q) => q.id === m.data.startQid);
        setIdx(i >= 0 ? i : 0);
      } else if (m.type === 'summaryUpdated') {
        setReport(m.data);
      } else if (m.type === 'wrongbookProgress') {
        setStreaks((prev) => ({ ...prev, [m.qid]: { streak: m.streak, passed: m.passed } }));
        if (m.graduated) setGraduated(m.qid);
      } else if (m.type === 'selfGraded') {
        // 自行打分已落盘：把分数回灌到本地作答里显示
        setAnswers((prev) => {
          const old = prev[m.qid];
          return {
            ...prev,
            [m.qid]: {
              ...old,
              value: old?.value ?? null,
              correct:
                m.grade.verdict === 'correct' ? true : m.grade.verdict === 'wrong' ? false : null,
              ts: old?.ts ?? Date.now(),
              grade: m.grade,
            },
          };
        });
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

  /** 错题本刷题：客观题答完立即判定并计入连对次数；主观题标记待批改 */
  const saveWrongbook = useCallback(
    (qid: string, value: string | string[] | null, correct: boolean | null) => {
      setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], value, correct, ts: Date.now() } }));
      post({ type: 'saveWrongbookAnswer', qid, value, correct } satisfies WebToHost);
      if (correct === false) setStreaks((prev) => ({ ...prev, [qid]: { streak: 0, passed: false } }));
    },
    [],
  );

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
    post({ type: 'syncSummary' } satisfies WebToHost);
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
    post({ type: 'syncSummary' } satisfies WebToHost);
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
  const wrong = data.wrongbook;
  const streak = streaks[q.id]?.streak ?? 0;
  const passed = streaks[q.id]?.passed ?? false;
  // 错题本刷题：判定状态只看本次会话是否提交过（不沿用原卷判定，避免一打开就锁定 + 剧透）
  const judged = wrong ? (committed[q.id] ?? false) : isObjective(q) && a?.correct != null;

  /**
   * 错题本：客观题只有点「提交并判定」才结算连对。
   * 点选项 / 输入过程只保存作答——否则多选点第一个选项、填空填第一空时答案还不完整，会被误判为错。
   */
  const commitObjective = (v: string | string[] | null) => {
    if (!wrong) return;
    if (isEmptyAnswer(v)) return; // 空答案不结算（防「重做本题」被当成答错）
    setCommitted((prev) => ({ ...prev, [q.id]: true }));
    saveWrongbook(q.id, v, judge(q, v) === true);
  };

  /**
   * 错题本：客观题自主判分。
   * 填空题答案写法多样（输出结果、命令顺序、等价写法），自动判定可能误杀 —— 看一眼参考答案自己判。
   */
  const judgeSelfObjective = (pass: boolean) => {
    if (!wrong || selfJudged[q.id]) return;
    setSelfJudged((prev) => ({ ...prev, [q.id]: pass ? 'pass' : 'fail' }));
    post({ type: 'selfJudge', qid: q.id, pass } satisfies WebToHost);
  };

  /** 错题本：客观题即时判定计连对；主观题存为待批改，导入批改后结算 */
  const onSave = (v: string | string[] | null, _c: boolean | null) => {
    if (!wrong) return save(q.id, v, _c);
    if (isEmptyAnswer(v)) {
      // 清空 / 重做本题：只清作答并解锁，绝不结算（否则会被当成答错）
      setCommitted((prev) => ({ ...prev, [q.id]: false }));
      setRevealed((prev) => ({ ...prev, [q.id]: false }));
      setSelfJudged((prev) => {
        const next = { ...prev };
        delete next[q.id];
        return next;
      });
      return save(q.id, v, null);
    }
    // 客观题作答过程：只更新作答内容，保留原卷判定不动（错题本的判定状态由 committed 单独管）
    if (isObjective(q)) return save(q.id, v, a?.correct ?? null);
    return saveWrongbook(q.id, v, null); // 主观题：标记待批改（或自评）
  };

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
          {!wrong && !paperJudged && (
            <button className="btn primary" onClick={submitPaper}>
              交卷 · 判定客观题
            </button>
          )}
          {!wrong && paperJudged && (
            <button className="btn ghost" onClick={clearJudgement}>
              清除判定
            </button>
          )}
          <button className="btn ghost" onClick={copyAll}>
            {wrong ? '复制本次作答（交给批改）' : '复制全部作答'}
          </button>
        </div>
      </header>

      {wrong && (
        <div className={`wrongbook-bar ${passed ? 'ok' : ''}`}>
          <span className="chip type">{wrong.kind === 'active' ? '错题本 · 待攻克' : '已过关错题'}</span>
          <span className="streak">
            连对 <b>{streak}</b> / {WRONG_STREAK_TARGET}
          </span>
          <span className="streak-dots">
            {Array.from({ length: WRONG_STREAK_TARGET }, (_, i) => (
              <span key={i} className={`dot ${i < streak ? 'on' : ''}`} />
            ))}
          </span>
          {passed && <span className="ok-text">已过关</span>}
          <span className="hint">
            {isObjective(q)
              ? q.type === 'single'
                ? '单选：点选即判定，答错清零'
                : `${q.type === 'multi' ? '多选' : '填空'}：填/选完点「提交并判定」才计入连对`
              : `主观题：保存后可自行打分（≥60 记一次连对），也可导出交给 AI 批改`}
          </span>
        </div>
      )}

      {graduated === q.id && (
        <div className="summary">
          🎉 本题已连续答对 {WRONG_STREAK_TARGET} 次，移出待攻克、进入「已过关错题」。
        </div>
      )}

      {summary && (
        <div className="summary">
          客观题判定完成：答对 <b>{summary.right}</b> / {summary.total}
          {summary.total > 0 && summary.right === summary.total ? ' 🎉 全对！' : ''}
          。主观题请用「导出本卷作答」：粘贴给 DeepSeek，或切到 WorkBuddy 对话说「批改」。
        </div>
      )}

      {report && report.judgedCount > 0 && (
        <div className="reportcard">
          <div className="reportcard-main">
            <div className="reportcard-score">
              {report.totalScore}
              <small>分</small>
            </div>
            <div className="reportcard-stats">
              <span>
                已判定 <b>{report.judgedCount}</b>/{report.questionCount} 题
              </span>
              <span className="ok">全对 {report.verdictCounts.correct}</span>
              <span className="mid">部分 {report.verdictCounts.partial}</span>
              <span className="bad">错 {report.verdictCounts.wrong}</span>
              {report.pendingCount > 0 && <span className="dim">待判定 {report.pendingCount}</span>}
            </div>
          </div>
          {report.weakTags.length > 0 && (
            <div className="reportcard-tags">
              薄弱方向：
              {report.weakTags.map((t) => (
                <span key={t} className="chip tag">
                  {t}
                </span>
              ))}
            </div>
          )}
          <div className="reportcard-overall">{report.overall || autoOverallText(report)}</div>
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
        <ChoiceView
          q={q}
          answer={a}
          onSave={onSave}
          {...(wrong
            ? {
                onCommit: commitObjective,
                commitLabel: '提交并判定（计入连对）',
                judgedOverride: !!committed[q.id],
              }
            : {})}
        />
      ) : q.type === 'fill' ? (
        <FillView
          q={q}
          answer={a}
          onSave={onSave}
          {...(wrong
            ? {
                onCommit: commitObjective,
                commitLabel: '提交并判定（计入连对）',
                judgedOverride: !!committed[q.id],
              }
            : {})}
        />
      ) : q.type === 'coding' ? (
        <CodingView q={q} answer={a} onSave={onSave} />
      ) : (
        <SubjectiveView q={q} answer={a} onSave={onSave} />
      )}

      {wrong && isObjective(q) && (
        <div className="selfjudge">
          <div className="selfjudge-head">
            <span className="selfjudge-title">自主判分</span>
            {selfJudged[q.id] && (
              <span className={`chip ${selfJudged[q.id] === 'pass' ? 'ok' : 'bad'}`}>
                已自评{selfJudged[q.id] === 'pass' ? '答对 · 计入连对' : '答错 · 打回待攻克'}
              </span>
            )}
          </div>
          <div className="selfjudge-row">
            <button
              className="btn ghost"
              onClick={() => setRevealed((p) => ({ ...p, [q.id]: !p[q.id] }))}
            >
              {revealed[q.id] ? '隐藏参考答案' : '查看参考答案'}
            </button>
            <button
              className="btn primary"
              disabled={!!selfJudged[q.id]}
              onClick={() => judgeSelfObjective(true)}
            >
              ✓ 我算对（计入连对）
            </button>
            <button
              className="btn ghost"
              disabled={!!selfJudged[q.id]}
              onClick={() => judgeSelfObjective(false)}
            >
              ✗ 我算错（打回）
            </button>
          </div>
          <div className="selfjudge-hint">
            点「提交并判定」是自动判定；答案写法多样（输出结果、命令顺序、等价写法）时，可直接按参考答案自主判分。
          </div>
          {revealed[q.id] && (
            <div className="answer-reveal">
              <b>参考答案（只看答案，不计分、不结算）</b>
              {referenceAnswerLines(q).length > 0 ? (
                referenceAnswerLines(q).map((line, i) => (
                  <div key={i} className="answer-line">
                    {line}
                  </div>
                ))
              ) : (
                <div className="answer-line dim">本题没有内置参考答案，请对照解析自己判断。</div>
              )}
            </div>
          )}
        </div>
      )}

      {wrong && !isObjective(q) && (
        <SelfGrade key={q.id} q={q} answer={a} streak={streak} passed={passed} />
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
            {a.grade.source === 'self' ? '自评' : '批改'}：{a.grade.score} 分 ·{' '}
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
