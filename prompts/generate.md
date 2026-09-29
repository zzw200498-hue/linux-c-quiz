你是 Linux 嵌入式应用层开发的资深面试官。请出一份 25 题的练习卷。

主题范围：{{在此填入本次主题，如：进程与fork、信号、线程与同步、IPC、文件IO、socket/epoll、内存管理}}
难度分布：基础 40%、进阶 40%、偏难 20%（偏难题标注 difficulty: 4 或 5）

【题型与数量——必须严格遵守，一道都不能少】
- single：8 道（4 个选项 A-D，恰 1 个正确；判断题也算 single：choices 为 ["正确","错误"]）
- multi：4 道（2-4 个正确，答案为字母数组，如 answer: [A, C]）
- fill：5 道（每题 1-3 个空，题干用 ____1____ 标记空位；答案必须唯一无歧义，附常见等价写法 alt）
- short：4 道（简答，给参考答案 referenceAnswer + 3-5 条评分要点 rubrics）
- rewrite：2 道（给一段有问题的 C 代码 originCode，要求改写；给参考改写 referenceCode + rubrics）
- coding：2 道（给 main 骨架 templateCode + 2-3 组测试 tests）

【输出格式——极度重要】
只输出一个 ```yaml 代码块，除此之外不要输出任何解释、开场白或总结。
顶层字段固定为 paper 和 questions。字符串含代码时一律用 | 多行块。严格按下面示例的字段名和缩进：

```yaml
paper:
  title: "Linux嵌入式应用层 练习卷 #1"
  topics: [进程, 信号, epoll]
  date: "2026-09-23"
questions:
  - id: q01
    type: single
    stem: "关于 fork() 下列说法正确的是："
    choices:
      - "子进程继承父进程未决信号"
      - "……"
      - "……"
      - "……"
    answer: B
    explain: "一句话解析"
    tags: [进程, fork]
    difficulty: 2
  - id: q02
    type: multi
    stem: "……"
    choices: ["…", "…", "…", "…"]
    answer: [A, C]
    explain: "…"
    tags: [IPC]
    difficulty: 3
  - id: q03
    type: fill
    stem: "使用 `____1____` 系统调用可创建匿名管道，其参数是大小为 2 的 ____2____ 数组。"
    blanks:
      - answer: pipe
        alt: [pipe2]
      - answer: int
        alt: ["整型"]
    explain: "…"
    tags: [IPC]
    difficulty: 1
  - id: q04
    type: short
    stem: "……"
    referenceAnswer: |
      ……
    rubrics:
      - "要点1"
      - "要点2"
    tags: [信号]
    difficulty: 3
  - id: q05
    type: rewrite
    stem: "以下代码存在线程安全问题，请改写修复："
    originCode: |
      #include <pthread.h>
      int counter = 0;
      void *worker(void *arg) { for (int i=0;i<100000;i++) counter++; return NULL; }
    referenceCode: |
      （修复后的完整代码，含 pthread_mutex_lock/unlock）
    rubrics:
      - "使用 mutex 或原子操作保护 counter"
      - "加锁范围覆盖整个自增循环或改用 atomic"
    tags: [线程]
    difficulty: 3
  - id: q06
    type: coding
    stem: "实现……（描述清楚输入输出约定，程序应把结果 printf 到 stdout）"
    language: c
    templateCode: |
      #include <stdio.h>
      /* 在此实现 */
      int main(void) { return 0; }
    solutionCode: |
      （完整可编译运行的参考答案。你必须在心里用它逐条跑一遍 tests，
      确认每个用例都能通过；工具也会真实运行自检，参考答案跑不过的用例会被判为坏用例）
    tests:
      - name: 基本用例
        args: []
        stdin: ""
        expectedStdout: "期望的完整输出"
        match: exact        # exact=精确比对；输出顺序可能变化时用 contains
        checkPresent: []    # 命令跑完后必须存在的文件（相对工作目录）
        checkAbsent: []     # 命令跑完后必须消失的文件（如 make clean 后的产物）
    tags: [字符串]
    difficulty: 2
```

coding 题硬性规则：**tests 里的 expectedStdout 检查什么，stem 里就必须逐字写明要求输出什么**（例如“全部拷贝完成后，向标准输出打印一行：拷贝完成”）。绝不允许用例期望一个题干没提到的输出。

【coding 题补充规则——务必遵守】
1. 程序运行的工作目录里只有 templateCode 生成的主文件和 files 里的文件。若程序需要输入文件（如要拷贝的 source.txt）或依赖其它源码/头文件（如多文件工程的 file_io.c/file_io.h），必须用 files 字段给出，键为文件名、值为完整内容：
   ```yaml
   files:
     source.txt: |
       第一行
       第二行
   ```
2. expectedStdout 只写程序自己 printf 的内容（不要把系统/编译器回显混进去），结尾通常带一个换行；
3. tests 的 args：C 题留空数组 []；Makefile 题（language: makefile）给 ["make"]、["make", "clean"] 这样的命令；
4. 语言字段：C 用 language: c，Makefile 题用 language: makefile 且 templateCode 放 Makefile 骨架；
5. **每个 coding 题必须给 solutionCode（完整参考答案）**，工具会真实运行参考答案来自检用例；
6. **断言行为而不比对无关细节**：凡是有多种等价写法的结果，不要用输出比对去卡。典型例子——`make clean` 删除产物的顺序无所谓，必须用 checkAbsent: [app, main.o, file_io.o] 检查"文件消失"，而不是比对 rm 命令的回显；make 产物是否生成用 checkPresent。输出比对只用于程序自己 printf 的内容；
7. 不要假设程序的实现细节（如 echo 回显、命令参数顺序、变量展开后的空格），学生合法的不同写法必须同样能通过。

最后再次强调：
1. 必须包含 multi 4 道、rewrite 2 道，否则这份卷不合格；
2. choices 数组元素不要带 "A." 前缀，按顺序即 A-D；
3. 代码一律放 | 多行块里，不要写在一行；
4. 只输出 yaml 代码块本身。
