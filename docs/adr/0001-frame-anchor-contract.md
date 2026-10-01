# Resolve the frame through the overlay layer, the only unconditional anchor

本插件的几何判定全部取自实时 DOM，所以每一次指针检查都必须先找到 shell 的 frame 元素。
frame 会发布若干个标记属性，但**其中只有一个在所有状态下都存在**：

| 锚点 | 出厂 shell 的渲染条件 |
|---|---|
| `data-shell-overlay` | **无条件**，是 frame 的常驻子元素 |
| `data-sidebar-collapsed` | `sidebarCollapsed \|\| void 0` —— 展开时 React 移除该属性 |
| `data-shell-leading` | `leadingMounted = darwin && sidebarCollapsed` —— 展开时整个元素卸载 |
| `data-sidebar-col` | **出厂布局根本不发布这个属性** |

只靠后三者定位，会在抽屉**展开时**丢掉 frame，于是 `pointerOverDrawer()` 恒返回 false ——
每一次"指针还在不在抽屉里"的判定都答"不在"。后果是：指针停在边缘不动会被判为离开、
抽屉收回、落回边缘条后重新计时、再抽出，形成**无限开合循环**；指针往右越过
`RETAIN_MARGIN`（48px）后也会被异常收回（48px 以内走"扶着边缘"分支，恰好掩盖了这个缺陷）。

因此 `frameOf()` **首选 `data-shell-overlay`**，它是唯一无条件存在的锚点；其余三级保留为兜底，
供发布了这些标记的其他 shell 使用。

## Consequences

两个测试夹具（`test/harness.html` 与 `test/client.test.mjs` 的 DOM doubles）**必须精确建模这份契约**。
一个把条件锚点写成常驻的夹具，会静默救回查找、让整套测试在一个已损坏的 bundle 上全绿 ——
这正是本缺陷当初能发布出去的原因，也是 `docs/implementation.md` 要求夹具与出厂契约同步的理由。
