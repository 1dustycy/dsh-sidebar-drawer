# Ship the mount row as a bundle patch, and let Plugin Manager own it

本包自带 `cordis.patch.yml`，并在 `package.json` 里声明 `dsh.bundle.patch`，而不是要求用户
把一行 `insert` 手工加进自己 profile 的 `cordis.patch.yml`。原因是**profile 的补丁文件是共享状态**：
曾有一个并行的会话保存过该文件，把手工加进去的那行整个覆盖掉，症状是插件"装了但没生效" ——
从插件自身的日志看一切正常，极难定位。

把挂载行放进 bundle 层，Plugin Manager 就成为这一行的**唯一写者**，跨安装、升级以及其他会话的写入
都不会丢失它。

## Consequences

`dsh plugin add` 只写一个依赖项和一条 bundle 条目，挂载行由包自己贡献。**手工编辑 profile 的补丁文件
永远不是必要步骤**，而它正是本决策要消灭的失效模式。卸载时同理：`dsh plugin remove` 会一并撤走。
