# 项目内存笔记 (memory notes)

这是开发过程中积累的踩坑/配方笔记的**仓库内快照**，随 git 走，换机器 `git clone` 就带着。
每个 `.md` 一条事实，带 frontmatter；`MEMORY.md` 是索引。内容要点也折进了 [`../HANDOFF.md`](../HANDOFF.md)。

**想让新机器上的 Claude 会话「活」地用这些记忆**（自动在相关时被召回），把这些文件拷到 Claude 的
内存目录，例如：

```
%USERPROFILE%\.claude\projects\<本项目的会话目录>\memory\
```

（本机原始位置是 `C:\Users\cam\.claude\projects\F--oolte\memory\`。）不拷也行——当成普通文档读即可，
关键几条 HANDOFF 已覆盖。

> 注意：这里是**快照**，不是活内存。之后 Claude 继续往 `~/.claude` 的内存目录写新笔记时，这份仓库副本
> 不会自动更新；需要时再 `cp` 同步一次即可。
