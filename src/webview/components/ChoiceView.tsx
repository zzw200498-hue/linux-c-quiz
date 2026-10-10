import { useEffect, useState } from 'react';
import type { Answer, Question } from '../../shared/types';

type Props = {
  q: Question;
  answer?: Answer;
  /** 只保存作答，不做判定 */
  onSave: (value: string | string[] | null, correct: boolean | null) => void;
  /** 错题本/随机刷题模式：点了「提交并判定」才调用，用于结算连对次数 */
  onCommit?: (value: string | string[] | null) => void;
  commitLabel?: string;
  /**
   * 是否显示「已判定」状态（覆盖 answer.correct）。
   * 错题本刷题时传 false：不沿用原卷的判定结果（否则一打开就锁定选项 + 剧透答案）。
   */
  judgedOverride?: boolean;
};

const LETTERS = 'ABCDEFGH';

/**
 * 单选 / 多选：点选只保存答案，不做即时判定；整卷「交卷」后统一显示对错与解析。
 * 多选在错题本模式下**必须**点「提交并判定」才结算：否则点第一个选项时答案还不完整，会被误判为错。
 */
export function ChoiceView({ q, answer, onSave, onCommit, commitLabel, judgedOverride }: Props) {
  const multi = q.type === 'multi';
  const judged = judgedOverride ?? (answer?.correct != null);
  const [sel, setSel] = useState<string[]>([]);

  useEffect(() => {
    const v = answer?.value;
    setSel(Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.id]);

  const pick = (letter: string) => {
    if (judged) return;
    if (multi) {
      setSel((s) => {
        const next = s.includes(letter) ? s.filter((x) => x !== letter) : [...s, letter];
        onSave(next, null);
        return next;
      });
    } else {
      setSel([letter]);
      // 单选一次点击就是完整答案：错题本模式下直接判定结算
      if (onCommit) onCommit(letter);
      else onSave(letter, null);
    }
  };

  const correctLetters = typeof q.answer === 'string' ? q.answer : (q.answer ?? []).join('');

  return (
    <div className="choices">
      {(q.choices ?? []).map((c, i) => {
        const letter = LETTERS[i];
        const picked = sel.includes(letter);
        let cls = 'opt';
        if (judged) {
          if (correctLetters.includes(letter)) cls += ' correct';
          else if (picked) cls += ' wrong';
        } else if (picked) cls += ' picked';
        return (
          <button key={i} className={cls} onClick={() => pick(letter)}>
            <span className="letter">{letter}</span>
            <code>{c}</code>
          </button>
        );
      })}

      {multi && !judged && (
        <button
          className="btn primary"
          disabled={sel.length === 0}
          onClick={() => (onCommit ? onCommit(sel) : onSave(sel, null))}
        >
          {commitLabel ?? '保存答案'}
        </button>
      )}

      {judged && (
        <button
          className="btn ghost"
          onClick={() => {
            setSel([]);
            onSave(null, null);
          }}
        >
          重做本题
        </button>
      )}
    </div>
  );
}
