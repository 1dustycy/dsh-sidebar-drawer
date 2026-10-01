# 实现要点

面向维护者：这个插件**怎么做的**、以及为什么这么做。应有的行为见 [behavior.md](./behavior.md)，
术语见 [CONTEXT.md](../CONTEXT.md)。

## 包形状

这是一个 DSH **plugin bundle**，半边是空的：

| 半边 | 文件 | 内容 |
|---|---|---|
| Host | `lib/index.js` | **空实现**。10 行，一个文档注释加 `export function apply() {}`，没有 import、没有 `inject`、不碰 `ctx` |
| Client | `lib/client.js` | 全部行为。注入 `["layout"]`，通过 `ctx.get("layout")` 取到服务，在 `ctx.effect` 里挂载 |
| Bundle 挂载行 | `cordis.patch.yml` | 一行 `insert`，由 Plugin Manager 托管。理由见 [ADR-0003](./adr/0003-bundle-patch-ownership.md) |

浏览器侧的模块 id 与包名一致：`dsh-sidebar-drawer`。patched 行的 id 是 `ui-sidebar-drawer`。

## 出厂锚点契约

插件的几何判定全部取自**实时 DOM**，所以它依赖 shell 发布的这一组标记。**只有第一个是无条件的**，
详见 [ADR-0001](./adr/0001-frame-anchor-contract.md)：

| 标记 | 谁发布 | 渲染条件 |
|---|---|---|
| `data-shell-overlay` | frame 的 overlay 层 | **无条件** —— frame 定位的首选锚点 |
| `data-sidebar-collapsed` | frame | 仅收起时（展开时 React 移除该属性） |
| `data-shell-leading` | frame 的 leading 座 | 仅 darwin 且收起时 |
| `data-animating` | frame | 仅列过渡期间，`transitionend` 时清除 |
| `data-dragging` | frame | 仅拖拽期间 |
| `data-side` | 列宽手柄 | 仅**展开**时挂载；侧栏手柄取值 `"sidebar"` |

> `frameOf()` 按上表顺序回退，`columnOf()` 取 `frame.firstElementChild`（出厂 shell 的第一个
> **真实**元素就是侧栏列 —— `DocumentTitle` 渲染 `null`，不产生元素）。

## 几何与判定

- 抽屉几何取自**实时 DOM**（`elementFromPoint` 与列的 `getBoundingClientRect`），而不是镜像布局
  store 的计算，因此调宽、右侧栏展开、开合动画都自然被包含。
- **动画期判定**（用户实测反馈后重做的部分）。抽屉从 0 长到 280px 要一整个过渡，期间"鼠标不在
  当前框里"并不等于"用户要走"，而且动画中途反转会让框架的过渡被打断、看起来是"突然消失"：

  0. **抽出要先"停留"**：指针在 10px 触发区内连续待够 `DWELL_MS` 才抽出；计时器在指针离开该区域、
     离开窗口、窗口 reflow 或拖动列宽时取消 —— 这让"扫过边缘"和"要用抽屉"区分开。
  1. 抽出后 `lastX <= RETAIN_MARGIN` 一律视为"还扶着边缘"，保持抽出。
  2. "指针在外面"的判定要经过 `CLOSE_DELAY_MS` 后的第二次确认；确认时若框架还在 `data-animating`
     （或自家 toggle 未结算），收回**不执行**，只重新武装，等动画真的停下再判。
  3. 动画结束时会把"被推迟的收回"按**当时的几何**重新判一次（不是丢弃），所以鼠标走远了照样会收。
  4. 收回期间鼠标回到边缘条，记下 `revealNextCheck`，动画一结束自动再抽一次 —— 不需要鼠标再动一下。
  5. `togglePending` 闸门保证本插件不会在过渡进行中发第二次 toggle（缺口见 behavior.md）。

- 动画是否结束**不靠猜时长**：轮询框架自己发布的 `data-animating`，所以过渡更慢的机器只是多等一会儿。
- 只有本插件打开的抽屉才会被本插件收回（`weOpened`）；收回动作本身有 `retracting` 标记，用来区分
  "正在长开的窄列"和"正在收起的窄列" —— 两者宽度一样，只有这个标记能说明方向。
- 指针事件按帧合并（一帧只算一次），热路径是两次 `getBoundingClientRect` 与偶尔一次
  `elementFromPoint`；鼠标不动时不做任何事。

## 可调参数

全部定义在 `lib/client.js` 顶部的常量块。**值以源码为准，此处刻意不复制**（复制出来的第二份真相
必然会漂移）：

| 常量 | 含义 |
|---|---|
| `EDGE_SIZE` | 左侧触发区宽度 |
| `DWELL_MS` | 在触发区内需要停留多久才算"要用抽屉" |
| `CLOSE_DELAY_MS` | 判定指针已离开后的收回宽限 |
| `POINTER_MARGIN` | 抽屉外沿允许的容差（右/上/下三边；左边缘**不给**容差，否则会吞掉触发区） |
| `RETAIN_MARGIN` | 越过它才算离开；此距离内一律视为"还扶着边缘" |
| `OPEN_SETTLED_WIDTH` | 宽度阈值：超过它才算"已抽出的抽屉"而非"正在移动的边缘" |
| `HANDLE_SELECTOR` | 侧栏列宽手柄的选择器（视为抽屉的一部分） |
| `ANIMATION_POLL_MS` | 延迟收回时轮询 `data-animating` 的间隔 |
| `ANIMATION_CEILING_MS` | 轮询上限，防止框架永不撤下标记 |
| `ANIMATION_HARD_STOP_MS` | 延迟收回的绝对兜底上限 |
| `MARK` | 挂载期间设在 documentElement 上的标记 |
| `ANIMATING_ATTR` | 列过渡进行中的框架标记 |
| `COLLAPSED_ATTR` | 侧栏收起的框架标记 |
| `DRAGGING_ATTR` | 正在拖拽列宽的框架标记 |
| `LEADING_ATTR` | leading 座锚点（**条件渲染**，仅作兜底） |
| `OVERLAY_ATTR` | overlay 层锚点（**无条件**，frame 定位首选） |

## 测试夹具必须与出厂契约同步

两套夹具 —— `test/harness.html` 与 `test/client.test.mjs` 里的 DOM doubles —— 都**必须**精确
建模上面那张锚点表。这不是洁癖，是本插件已经付出过代价的地方：

> 两个夹具都曾把**条件锚点写成常驻**，于是"抽屉展开时 frame 找不到"这个缺陷被静默救回，
> 两套用例全绿，而真实 app 里指针停在边缘不动就会无限开合。

因此：**收紧锚点模型会让用例变红，那是夹具在变忠实，不是用例坏了。** 改夹具时优先问"出厂 shell
在这里到底发布什么"，而不是"怎么让用例过"。

`test/browser.test.mjs` 的第 1 项专门断言夹具自身的契约 —— 收起/展开两态下的锚点存续、手柄挂载、
列宽、标记取值；`node tools/probe.mjs` 会打印每次判定的 `frameFound` 字段。两者都可直接见证这份契约。

### 夹具的已知缺口

夹具尚未建模出厂 shell 的**窄窗口自动收起**（`SIDEBAR_AUTO_COLLAPSE`）。视口窄于该阈值时，
frame 改用 `narrowExpanded`（而非 `sidebar`）决定 `sidebarCollapsed`，而且**视口驱动的收起
刻意不发布 `data-animating`** —— 插件的延迟收回逻辑会去等一个永不出现的标记。两套夹具都把视口
固定在宽屏，因此整条窄窗口路径目前没有任何用例覆盖。修夹具时优先补这一块。
