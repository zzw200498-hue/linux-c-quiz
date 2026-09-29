import * as vscode from 'vscode';
import type { Answer, PaperFile, Question } from '../shared/types';
import { TYPE_LABEL } from '../shared/types';
import {
  hasKnowledge,
  knowledgeState,
  renderTooltip,
} from '../shared/knowledge';
import type { Store } from '../core/store';

/** 侧栏悬停提示内容策略 */
export type TooltipMode = 'judged' | 'answered' | 'always' | 'off';

function tooltipMode(): TooltipMode {
  const v = vscode.workspace.getConfiguration('quiz').get<string>('knowledgeTooltip', 'answered');
  return v === 'judged' || v === 'always' || v === 'off' ? v : 'answered';
}

export class PaperNode {
  constructor(public paper: PaperFile) {}
}

export class QuestionNode {
  constructor(
    public paperFile: PaperFile,
    public q: Question,
    public index: number,
    public answer?: Answer,
  ) {}
}

export type TreeNode = PaperNode | QuestionNode;

export class PapersProvider implements vscode.TreeDataProvider<TreeNode> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private state: Record<string, Record<string, Answer>> = {};

  constructor(private store: Store) {}

  async refresh(): Promise<void> {
    const st = await this.store.loadState();
    this.state = st.papers;
    this.emitter.fire();
  }

  getTreeItem(el: TreeNode): vscode.TreeItem {
    if (el instanceof PaperNode) {
      const answers = this.state[el.paper.file] ?? {};
      const answered = el.paper.questions.filter((q) => answers[q.id]?.value != null).length;
      const item = new vscode.TreeItem(el.paper.paper.title, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${answered}/${el.paper.questions.length} 已答`;
      item.tooltip = new vscode.MarkdownString(
        [
          `**${el.paper.paper.title}**`,
          '',
          `进度：${answered}/${el.paper.questions.length} 已答`,
          el.paper.paper.topics?.length ? `主题：${el.paper.paper.topics.join(' / ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      item.iconPath = new vscode.ThemeIcon('book');
      item.contextValue = 'paper';
      item.command = {
        command: 'linux-c-quiz.openPaper',
        title: '打开试卷',
        arguments: [el.paper.file],
      };
      return item;
    }

    const { q, index } = el;
    const a = el.answer;
    let icon = 'circle-large-outline';
    let status = '未作答';
    if (a?.value != null) {
      if (a.grade) {
        icon = a.grade.verdict === 'correct' ? 'pass' : a.grade.verdict === 'wrong' ? 'error' : 'pencil';
        status = `${a.grade.score} 分 · ${a.grade.verdict}`;
      } else if (q.type === 'coding' && a.lastRun && a.lastRun.total > 0) {
        icon = a.lastRun.passed === a.lastRun.total ? 'pass' : 'pencil';
        status = `用例 ${a.lastRun.passed}/${a.lastRun.total}`;
      } else if (a.correct === true) {
        icon = 'pass';
        status = '正确';
      } else if (a.correct === false) {
        icon = 'error';
        status = '错误';
      } else {
        icon = 'circle-filled';
        status = q.type === 'single' || q.type === 'multi' || q.type === 'fill' ? '已答' : '待批改';
      }
    }
    const item = new vscode.TreeItem(
      `${String(index + 1).padStart(2, '0')} · ${TYPE_LABEL[q.type]}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = status;
    item.tooltip = buildQuestionTooltip(q, a, index);
    item.iconPath = new vscode.ThemeIcon(icon);
    item.contextValue = q.type === 'coding' ? 'question-coding' : 'question';
    item.command = {
      command: 'linux-c-quiz.openQuestion',
      title: '打开题目',
      arguments: [el.paperFile.file, q.id],
    };
    return item;
  }

  async getChildren(el?: TreeNode): Promise<TreeNode[]> {
    if (!el) {
      const papers = await this.store.listPapers();
      return papers.map((p) => new PaperNode(p));
    }
    if (el instanceof PaperNode) {
      const answers = this.state[el.paper.file] ?? {};
      return el.paper.questions.map((q, i) => new QuestionNode(el.paper, q, i, answers[q.id]));
    }
    return [];
  }
}

/**
 * 悬停提示：默认为已判定 / 已批改的题目显示知识点（正确答案、解析、参考答案、要点），
 * 未判定时只显示题干，避免做题过程中剧透。
 */
function buildQuestionTooltip(q: Question, a: Answer | undefined, index: number): vscode.MarkdownString {
  const mode = tooltipMode();
  const state = knowledgeState(a);
  let show = false;
  if (mode !== 'off' && hasKnowledge(q)) {
    if (mode === 'always') show = true;
    else if (mode === 'answered') show = state !== 'none';
    else show = state === 'judged';
  }
  if (!show) return new vscode.MarkdownString(`**${q.stem.slice(0, 200)}**`);
  const md = new vscode.MarkdownString(renderTooltip(q, a, index));
  md.supportThemeIcons = false;
  return md;
}
