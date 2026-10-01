# Arm the frame's own transition marker before asking for a toggle

出厂 frame 的列过渡只由它自己的 `data-animating` 标记发布：

```css
.frame[data-animating] { transition: grid-template-columns 300ms var(--ds-ease-in-out) }
```

而 shell 的写入顺序是**先列宽、后标记**，中间还夹着一次布局读取：

1. 第一遍（store 更新）：写 `data-sidebar-collapsed`，写 `grid-template-columns`；
2. 同一次提交流程里，app 的 tab/pane 组件在 layout effect 里读布局（实测命中
   `section._pane_*`、`div._tabStrip_*`、`div._stripFill_*` 的 `getBoundingClientRect`）；
3. 第二遍（`setAnimating` 触发的同步重渲染）才写 `data-animating`。

浏览器在第二步就已经采用了新的轨道尺寸 —— 那一刻 `transition-property` 还是 `all 0s`，
第三步才生效的过渡属性不会追认已经落地的值。于是列宽**瞬变**：实测出厂 app 里
`transitionrun/start/end` 一个都不来，`data-animating` 是被 shell 自己的 600ms 兜底定时器清掉的，
而且**出厂 shell 自己的侧栏按钮也是同样的瞬变**（不是本插件独有的路径）。

最小复现（同一页面、同一 task 内）：`style` → `data-animating` 正常插值；
`style` → `getBoundingClientRect()` → `data-animating` 直接跳到目标值。

## Decision

本插件在请求 toggle **之前**，把框架自己的 `data-animating` 标记写上（值为 `drawer`，
与 shell 的 `"true"` 可辨识），让 shell 随后写入的列宽落在一个**已经生效**的过渡上。

- shell 一旦接管（它渲染 `"true"`），标记的所有权与生命周期都归它：它在 `transitionend`
  或自己的 600ms 兜底里清除，本插件不再插手；
- shell 从未接管时（列宽其实没变的竞态，例如视口变更让 shell 跳过标记），本插件在
  **该列过渡结束时**撤回自己的标记；`ANIMATION_CEILING_MS` 只作兜底。

## Consequences

- 抽出与收回都真的滑动（实测展开方向插值 56 → 280，19 个中间宽度，`transitionrun/start/end` 齐备）。
- 预置只发生在**本插件发起的 toggle** 上，因此 shell 的视口驱动开合（它刻意不发布标记）不受影响。
- 这个标记同时是 shell 的列宽手柄、占位方滑动共用的"离散列变化"信号：预置之后它们按出厂设计
  一起走同一条曲线 —— 这正是 shell 的 README 承诺的语义，不是本插件的额外发明。
- 出厂 shell 自己的开合按钮仍会瞬变（那是 shell 侧的写入顺序问题，本插件无从插手）。
- 夹具必须建模这次"先列宽、后标记、中间读布局"的顺序，否则夹具会把这个瞬变静静救回：
  `test/harness.html` 的 `applyColumns()` 与 `test/client.test.mjs` 的 DOM 替身都已照此收紧
  （见 [implementation.md](../implementation.md#测试夹具必须与出厂契约同步)）。
