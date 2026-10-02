# While the sidebar is collapsed, the reveal strip is the trigger — not the drawer

侧栏收起时，**不参与"指针在不在抽屉里"这个判定**：收起态的列本身就是触发区，去问"在不在里面"
是自相矛盾的。收起态的侧栏在零宽列内部仍保留一个**全宽的内容盒**，只是被 `overflow: hidden`
裁掉；无防护的命中测试（`elementFromPoint`）会把这块看不见的内容读成"指针已经在抽屉内"，
于是停留计时永远武装不上，**抽屉永远抽不出来**。

> 注意：宽度手柄**不是**这里的原因。出厂 shell 只在侧栏**展开**时挂载侧栏手柄
> （`!sidebarCollapsed && jsx(DragHandle, …)`），所以它不可能骑在收起态的边上。
> 早先的文档把这个手柄写成了原因，那是错的。

## Consequences

宽度不足 `OPEN_SETTLED_WIDTH` 的列，**命中测试那一段**被 `pointerOverDrawer()` 挡掉（除非找到已挂载的
手柄）——被 `overflow: hidden` 裁掉的全宽内容盒正是从那里读出来的。但整条函数并不是"窄列一律
返回 false"：盒子判定排在前面，56px 图标栏那种宽度会从那里返回 true。

真正让这条不变量成立的是 `checkPointer()` 的提前返回：收起态走触发区分支并就地 return，
`over` 虽被算出来，却轮不到参与判定；再往后还有一道 `if (!weOpened) return;`。而
`pointerProvenOutside()` 的两个消费者（宽限到期、toggle 结算）都在 `weOpened` 为真时才会问它。
零宽收起态由 `rect.width <= 0.5` 那一行挡住。

收起态由 `drawerIsClosed()` 决定（读 frame 自己的标记），而不是靠宽度推断 —— 窄列同样意味着
动画期（抽出还没走完），把它读成收起会取消指针要求的收回动作。
