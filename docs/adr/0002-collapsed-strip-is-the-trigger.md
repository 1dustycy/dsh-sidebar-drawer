# While the sidebar is collapsed, the reveal strip is the trigger — not the drawer

侧栏收起时，**不参与"指针在不在抽屉里"这个判定**：收起态的列本身就是触发区，去问"在不在里面"
是自相矛盾的。收起态的侧栏在零宽列内部仍保留一个**全宽的内容盒**，只是被 `overflow: hidden`
裁掉；无防护的命中测试（`elementFromPoint`）会把这块看不见的内容读成"指针已经在抽屉内"，
于是停留计时永远武装不上，**抽屉永远抽不出来**。

> 注意：宽度手柄**不是**这里的原因。出厂 shell 只在侧栏**展开**时挂载侧栏手柄
> （`!sidebarCollapsed && jsx(DragHandle, …)`），所以它不可能骑在收起态的边上。
> 早先的文档把这个手柄写成了原因，那是错的。

## Consequences

`pointerOverDrawer()` 对宽度不足 `OPEN_SETTLED_WIDTH` 的列直接返回 false（除非找到已挂载的手柄），
于是这个宽度信号**只有抽出闸门一个消费者**。收起态由 `drawerIsClosed()` 决定（读 frame 自己的标记），
而不是靠宽度推断 —— 窄列同样意味着动画期（抽出还没走完），把它读成收起会取消指针要求的收回动作。
