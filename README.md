# dsh-sidebar-drawer

左侧栏边缘抽屉：侧栏收起时，把鼠标移到**屏幕最左边 10px 内并停留 500ms** 就会抽出侧栏；鼠标停在抽屉里期间一直保持抽出；鼠标离开抽屉后自动收回。

一个纯浏览器行为插件（Host 半边是空的），只借用 DSH 自己的 `ctx.layout.toggleSidebar()`，不改动任何内置文件。

## 行为细节

| 场景 | 表现 |
|---|---|
| 侧栏收起 + 鼠标在左侧 **10px** 内停留 **500ms** | 抽出侧栏（路过不算，见下两行） |
| 鼠标只是掠过左侧边缘（不足 500ms 就走） | 不抽出 |
| 停留中把鼠标移出这 10px（比如继续往右走） | 取消这次抽出，计时重新开始 |
| 抽出动画进行中，鼠标往里挪一点就停住 | **继续抽出并保持**，等抽屉长到鼠标位置，不会"啪"地收回 |
| 抽出动画进行中，鼠标继续往右扫 | 只要最终落在抽屉里就保持抽出（收回判定一直等到动画结束再做） |
| 鼠标在抽屉内（含点击、滚动、停留） | 保持抽出 |
| 抽出后往边缘退一点（左边缘 48px 以内） | 仍算"扶着边缘"，保持抽出（不会重新计时） |
| 鼠标移到左边缘 48px 之外、且不在抽屉内 | 260ms 宽限后收回；期间回到抽屉内会取消 |
| 收回动画进行中，鼠标又回到边缘条 | 记下这个意图，等动画结束再抽一次（不会打到一半被打断） |
| 收回后鼠标一直停在边缘条上不动 | 同样会再抽一次（按"鼠标在边缘"判定，不依赖新事件） |
| 鼠标移出窗口 / 窗口失焦 | 视为离开抽屉，同样收回（旧坐标不会否决这个结论） |
| 用户自己打开的侧栏（按钮、Cmd+B、拖拽调宽、窄窗口展开） | 完全不管，不会被边缘行为收回 |
| 正在拖动宽度手柄 | 不触发，不打断拖拽 |
| 窗口尺寸变化 / 页面滚动 | 丢弃过期的鼠标采样，避免用旧坐标判错 |

**关键约束**

1. **任何开合动画进行中都不会发出第二次 toggle。** 中途反转会打断框架自己的过渡，视觉上就是"突然没了"而不是滑出 —— 所有延迟的意图都会在动画结束后重新判定一次。
2. **抽屉收起时，"指针在不在抽屉里"这个问题不参与判定。** 收起态的列是 x=0 处的 0px 条，而宽度手柄的命中带骑在这条边上；若还去问"在不在抽屉里"，手柄的命中带会把整个触发区判成"已在抽屉内"，停留计时永远武装不上（抽屉再也打不开），或者反过来在抽出瞬间被判"已离开"（无限开关）。收起时这块 10px 就是触发区本身。
3. **"指针离开窗口"只由窗口级的 `pointerleave`/`pointerenter` 决定**，不用坐标去猜：鼠标静止不动时不会有任何新事件，靠猜会把"停着不动"误判成"已经离开"，从而在抽屉内部反复收回。

参数都在 `lib/client.js` 顶部：`EDGE_SIZE`（触发区宽度，10px）、`DWELL_MS`（停留时长，500ms）、`CLOSE_DELAY_MS`（收回宽限，260ms）、`RETAIN_MARGIN`（"还在扶边缘"的范围，48px）、`POINTER_MARGIN`（抽屉外沿容差，4px）、`HANDLE_SELECTOR`（把宽度手柄算作抽屉的一部分）、`OPEN_SETTLED_WIDTH`（判定"已抽出"的宽度阈值，56px）、`ANIMATION_POLL_MS`（动画期轮询间隔，120ms）、`ANIMATION_CEILING_MS` / `ANIMATION_HARD_STOP_MS`（轮询上限与绝对兜底）。

## 安装

这是一个 DSH **plugin bundle**：包内自带 `cordis.patch.yml`，`package.json` 里声明了
`dsh.bundle.patch`，所以它由 Plugin Manager 安装并托管挂载行，不需要你手改 profile 的补丁文件。

```bash
# 从 GitHub 安装（推荐，带 tag 钉住版本）
dsh plugin --profile desktop add "github:1dustycy/dsh-sidebar-drawer#v0.1.0"

# 跟随 main 最新提交（不带 tag，便于拿到最新行为改动）
dsh plugin --profile desktop add github:1dustycy/dsh-sidebar-drawer

# 从本地目录安装（开发用）
dsh plugin --profile desktop add /path/to/dsh-sidebar-drawer
```

> 尚未发布到 npm。等行为稳定、确认要长期维护后再考虑，届时可直接
> `dsh plugin --profile desktop add dsh-sidebar-drawer`。

把 `desktop` 换成你要装的 profile 名（如 `web`、`tui`）。这条命令做两件事：把包装进
`~/.dsh/profiles/<name>/package.json` 的 `dependencies`，并把 `dsh-sidebar-drawer` 加进该 profile 的
`dsh.profile.bundles`。装完后**刷新页面**即可生效，不需要重启 App（客户端半边由 bundle 的 mtime
轮询 + `/plugins/events` 热加载）。

卸载：

```bash
dsh plugin --profile desktop remove dsh-sidebar-drawer
```

**要求**：DSH Desktop（或任何带 Web GUI 的 profile）。客户端半边注入
`@deepseek-ai/dsh-client-ui-layout`，所以目标 profile 必须已挂载 Web 布局 bundle。
`peerDependencies` 为 `@deepseek-ai/cordis >=4.0.4 <5`。

## 开发与验证

```bash
node test/client.test.mjs    # 24 个行为用例，vm + DOM 替身 + 会推进的虚拟时钟，不需要浏览器
node test/browser.test.mjs   # 15 个用例，真实 Chromium + CDP 真实鼠标事件与真实 CSS 动画
node tools/probe.mjs         # 诊断工具：打印一次边缘悬停的决策轨迹
npm pack --dry-run           # 确认发布内容（lib/ + cordis.patch.yml + README + LICENSE）
```

### 从源码开发时挂载

开发本包时也可以直接 `link:` 当前目录，让改动即时生效：

```bash
dsh plugin --profile desktop add /path/to/dsh-sidebar-drawer
```

`dsh plugin add` 对本地目录写入的是 `link:` 依赖，等价于下面两处手工状态：
`~/.dsh/profiles/<name>/package.json` 的 `dependencies` 指向本目录，
`dsh.profile.bundles` 里有 `dsh-sidebar-drawer`。包内另有 `cordis.patch.yml`，
它对 profile 贡献的补丁就是一行 `insert`：

```
- insert:
    - id: ui-sidebar-drawer
      name: dsh-sidebar-drawer
```

> 注意：profile 的 `cordis.patch.yml` 是与其他会话共享的文件。曾有另一个会话保存过该文件、
> 把手工加的 `insert` 行整个覆盖（现象是插件"装了但没生效"）。用 `dsh plugin add` 交给
> Plugin Manager 托管就不会有这个问题 —— 那正是本包带上 `dsh.bundle.patch` 的原因。

改 `lib/client.js` 后**刷新页面**即可生效：Host 每 500ms 轮询该 bundle 的 mtime，变化后通过 `/plugins/events` 通知浏览器重新加载模块（前提是 profile 的 `hmr` 行处于启用状态，桌面 profile 默认启用）。

`test/browser.test.mjs` 自带 HTTP 服务与浏览器进程，跑完即退出；需要本机有 Chromium（找不到会自动跳过）。
`SHOT=<路径> node test/browser.test.mjs` 会把最后"抽屉打开"的画面存成 PNG（`docs/harness-open.png` 即由此生成）。
`test/harness.html` 是内置三栏框架的等价复刻（栅格列 0px 收起、开合动画、`data-sidebar-collapsed` 标记、宽度手柄），
用浏览器直接打开它并加 `?plugin=<client.js 的 URL>` 也能手工试。

## 实现要点

- 抽屉几何取自**实时 DOM**（`elementFromPoint` 与列的 `getBoundingClientRect`），而不是镜像布局 store 的计算，因此调宽、右侧栏展开、开合动画都自然被包含。
- **动画期判定**（用户实测反馈后重做的部分）。抽屉从 0 长到 280px 要一整个过渡，期间"鼠标不在当前框里"并不等于"用户要走"，而且动画中途反转会让框架的过渡被打断、看起来是"突然消失"。所以：
  0. **抽出要先"停留"**：指针在 10px 触发区内连续待够 `DWELL_MS`（500ms）才抽出，计时器在指针离开该区域、离开窗口、窗口 reflow 或拖动列宽时取消 —— 这让"扫过边缘"和"要用抽屉"区分开；
  1. 抽出后，`lastX <= RETAIN_MARGIN`（48px）一律视为"还扶着边缘"，保持抽出；
  2. "指针在外面"的判定要经过 `CLOSE_DELAY_MS` 后的第二次确认；确认时若框架还在 `data-animating`（或自家 toggle 未结算），收回**不执行**，只重新武装，等动画真的停下再判；
  3. 动画结束时会把"被推迟的收回"按**当时的几何**重新判一次（不是丢弃），所以鼠标走远了照样会收；
  4. 收回期间鼠标回到边缘条，记下 `revealNextCheck`，动画一结束自动再抽一次 —— 不需要鼠标再动一下；
  5. `toggleSidebar()` 自带 `togglePending` 闸门：任何过渡进行中都不发第二次 toggle，这是"不再突然消失"的根本原因。
- 动画是否结束**不靠猜时长**：轮询框架自己发布的 `data-animating`（它在每次离散列变化期间设置、在 `transitionend` 清除），所以过渡更慢的机器只是多等一会儿，不会提前判。
- 只有本插件打开的抽屉才会被本插件收回（`weOpened`）；收回动作本身有 `retracting` 标记，用来区分"正在长开的窄列"和"正在收起的窄列"——两者宽度一样，只有这个标记能说明方向。
- 抽屉"在不在指针下"的判定分两种情况：**已抽出**时按实时框（`getBoundingClientRect` + 命中测试，手柄算作抽屉的一部分）；**收起**时这个判定根本不参与，那块区域就是触发区。
- 用户手动打开的一律放行；拖宽度手柄、窗口失焦、页面滚动/缩放都有对应的让路逻辑。
- 指针事件按帧合并（一帧只算一次），热路径是两次 `getBoundingClientRect` 与偶尔一次 `elementFromPoint`；鼠标不动时不做任何事。
