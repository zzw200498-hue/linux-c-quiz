import { useEffect, useState } from 'react';
import type { Answer, Question } from '../../shared/types';

type Props = {
  q: Question;
  answer?: Answer;
  onSave: (value: string | string[] | null, correct: boolean | null) => void;
};

const LETTERS = 'ABCDEFGH';

/** 单选 / 多选：点选只保存答案，不做即时判定；整卷「交卷」后统一显示对错与解析 */
export function ChoiceView({ q, answer, onSave }: Props) {
  const multi = q.type === 'multi';
  const judged = answer?.correct != null;
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
      onSave(letter, null);
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
        <button className="btn primary" disabled={sel.length === 0} onClick={() => onSave(sel, null)}>
          保存答案
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
