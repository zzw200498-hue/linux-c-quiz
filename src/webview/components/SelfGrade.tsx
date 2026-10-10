import { useState } from 'react';
import type { Answer, Question, WebToHost } from '../../shared/types';
import { PASS_SCORE, WRONG_STREAK_TARGET } from '../../shared/wrongbook';
import { post } from '../vscode';

type Props = {
  q: Question;
  answer?: Answer;
  /** 当前连对次数（用于提示还差几次过关） */
  streak: number;
  passed: boolean;
};

/**
 * 主观题自行打分（只在错题本 / 随机刷题模式出现）：
 * 自己给 0-100 分，≥60 记一次连对，<60 打回待攻克。
 * 用 key={q.id} 挂载，切题时自动重置输入框。
 */
export function SelfGrade({ q, answer, streak, passed }: Props) {
  const cur = answer?.grade?.score;
  const selfScored = answer?.grade?.source === 'self';
  const [val, setVal] = useState<string>(typeof cur === 'number' ? String(cur) : '');
  const [err, setErr] = useState('');

  const answered =
    answer?.value != null && (Array.isArray(answer.value) ? answer.value.length > 0 : answer.value !== '');

  const submit = (raw: string | number) => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setErr('请填 0 - 100 之间的整数');
      return;
    }
    setErr('');
    setVal(String(n));
    post({ type: 'selfGrade', qid: q.id, score: n } satisfies WebToHost);
  };

  const left = Math.max(0, WRONG_STREAK_TARGET - streak);

  return (
    <div className="selfgrade">
      <div className="selfgrade-head">
        <span className="selfgrade-title">自行打分</span>
        {selfScored && <span className="chip self">已自评 {cur} 分</span>}
        {passed && <span className="chip ok">已过关</span>}
      </div>

      {!answered && <div className="selfgrade-hint">先保存你的作答，再给自己打分。</div>}

      {answered && (
        <>
          <div className="selfgrade-row">
            <input
              className="selfgrade-input"
              type="number"
              min={0}
              max={100}
              step={5}
              value={val}
              placeholder="0-100"
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit(val);
              }}
            />
            <button className="btn primary" onClick={() => submit(val)}>
              提交自评
            </button>
            <span className="selfgrade-quick">
              {[100, 80, PASS_SCORE, 40, 0].map((n) => (
                <button key={n} className="btn ghost" onClick={() => submit(n)}>
                  {n === PASS_SCORE ? `及格 ${n}` : n === 100 ? '全对' : n === 0 ? '不会' : n}
                </button>
              ))}
            </span>
          </div>
          <div className="selfgrade-hint">
            ≥ {PASS_SCORE} 分记一次连对（连对 {WRONG_STREAK_TARGET} 次过关
            {!passed && left > 0 ? `，还差 ${left} 次` : ''}）；&lt; {PASS_SCORE} 分打回待攻克、连对清零。
            自评只用于刷题进度，不改动原卷成绩单。
          </div>
          {err && <div className="selfgrade-err">{err}</div>}
        </>
      )}
    </div>
  );
}
