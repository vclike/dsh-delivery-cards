# dsh-delivery-cards

DSH Web 的**独立交付卡片行**：在存在 `present` 声明的回合接替渲染，卡片交互按使用频次排序。

**零依赖 · 零构建**——宿主半边与浏览器半边都是手写的 ESM / 手写 bundle，
装的时候**不需要 `pnpm install`，也没有任何编译步骤**。

## 特性

- **两个常驻按钮**：「打开」（默认程序）/「定位」（文件资源管理器）——不像官方卡片要点箭头展开二级菜单
- **点卡片空白处 = 侧边栏预览**
- **11 类文件类型图标**：PDF / DOC / 表格 / PPT / MD / HTML / 图片 / 视频 / 音频 / 压缩包 / 代码；
  未收录的扩展名回落成扩展名文字徽标（比一个通用文件图标信息量大）
- **亮暗双主题**：配色全部走主题 token，无一硬编码色值
- 顺手修掉两个缺陷：交付卡片被相邻插件抢链而消失；`windowsHide` 导致「定位」打开的窗口**不可见**

## 安装

插件尚未发布到 npm，从 GitHub 或本地源码装：

```bash
# 从 GitHub
dsh plugin --profile web add github:vclike/dsh-delivery-cards

# 本地开发（改源码即时生效）
git clone https://github.com/vclike/dsh-delivery-cards.git
dsh plugin --profile web add link:D:/path/to/dsh-delivery-cards
```

**还必须把包名登记进 profile 的 `dsh.profile.bundles`**，否则浏览器半边不会被组装进启动图：

```jsonc
// <DSH_HOME>/profiles/web/package.json
{
  "dependencies": { "dsh-delivery-cards": "link:D:/path/to/dsh-delivery-cards" },
  "dsh": { "profile": { "bundles": [
    // …
    "dsh-delivery-cards"          // ← 加这一行
  ] } }
}
```

最后**重启 `dsh web`**（客户端 bundle 的修订号是进程随机数、不是内容哈希，改前端必须重启）。

> ⚠️ **不要在 profile 的 `cordis.patch.yml` 里手写 `insert:` 行。** 宿主行由随包的
> `cordis.patch.yml` 经 `dsh.profile.bundles` **自动插入**；同一个 `id` 出现两次时
> cordis loader 会直接抛错、**fresh `dsh web` 起不来**。注意 `--dump-config` 只做层叠组合、
> 不做 id 去重，所以它照样 `exit=0`，会掩盖这个问题。

### 环境要求

| | |
|---|---|
| DSH | `^0.1.5-rc.1`（在 `0.1.5-rc.2` 上实测） |
| Node | `>=20` |
| 平台 | Windows 上的「定位」带原生修复；非 win32 一律回落上游实现 |

**卸载**：从 `dsh.profile.bundles` 与 `dependencies` 各删一行，再删
`node_modules/dsh-delivery-cards`。

## 它解决什么

`conversation.chat.turnTail` 是 chain slot——**第一个 accept 的渲染，其余全跳过**。

| 注册者 | priority | select 条件 |
|---|---|---|
| **本插件** | **-2** | 本轮存在 `present` 声明 |
| `dsh-better-sidebar` | -1 | 本轮有 `write`/`edit` 产出 |
| `@deepseek-ai/dsh-client-ui-deliverables`（官方） | 未设 = 0 | `produced + presented > 0` |

better-sidebar 抢先接手后，官方那条（**chips 与交付卡片是同一个组件**）整条被跳过，
于是产出 chips 有了、`present` 卡片没了。它的注释自认这是 `interception`、
`visual twin of the deliverables chips`——**只复刻了 produced 那一半**。

本插件用 `-2` 插到最前，**只在有 `present` 声明时接手**；没有 `present` 的回合一律弃权，
把链交还 better-sidebar（行为与装本插件前完全一致）。

## 卡片交互

```
┌──────────────────────────────────────────────────────────┐
│ [MD]  行业研究报告.md                    打开      定位     │
│       Markdown · 2026 行业调研                             │
└──────────────────────────────────────────────────────────┘
   ↑ 点卡片空白处 = 侧边栏预览     ↑ 两个常驻按钮，无折叠、无箭头
```

| 手势 | 行为 |
|---|---|
| 点卡片空白处（或 Enter/Space） | 侧边栏预览 |
| 「打开」 | 宿主**默认程序**打开 |
| 「定位」 | **电脑资源管理器**中显示 |

两个按钮**常驻可见**——不像官方卡片要点箭头展开二级菜单。

原生动作**复用官方路由** `POST /api/present.open?sessionId&seq&index&action=open|reveal`：
它带鉴权、事件校验、路径往返验证，并给出可区分的错误码。失败时卡片上**直接写明原因与状态码**：

| HTTP | 卡片提示 |
|---|---|
| 0 | 请求没有发出（网络或连接层失败） |
| 400 | 请求坐标无效：会话或声明缺失 |
| 401 / 403 | 没有权限执行该操作 |
| 404 | 文件已不存在或已被移走 |
| 409 | 此主机没有可用的桌面 |
| 422 | 无法验证该文件的主机路径 |

### 可靠性原则：按钮永不禁用，失败必须可见

**踩过的坑**：早期版本在渲染前先探测 `/api/present.host`，探测失败就把两个按钮禁用、
只在 tooltip 里写原因。后果是「点了完全没反应，界面上没有任何文字」——而且探测结果被
模块级缓存，一次瞬时失败会让按钮**永久失效直到刷新**。

现在：**不做前置探测、按钮永不禁用**（只在请求进行中临时禁用），直接发请求由服务端裁决；
失败时把**状态码**写在卡片上。任何残留问题都会立刻可见，而不是静默。

另外，`sessionId` 取自**标准 prop**（官方 `Deliverables` 也是这么拿的），`inject` 的返回值
只作兜底并放在 `injectedSessionId` 这个独立键上——反过来写会把真值覆盖成 `undefined`，
请求就会变成 `sessionId=undefined` 并得到 400。拿不到时会明说「缺少会话标识」。

## ⚠️ 上游缺陷：`windowsHide` 让资源管理器窗口被创建成「不可见」

**实测确认的根因**（2026-09-13）。`@deepseek-ai/dsh-native-command` 的 `revealNativePath`：

```js
await run('explorer.exe', ['/select,', target], signal)   // 内部是 execFile(..., { windowsHide: true })
```

`windowsHide` 会把子进程 `STARTUPINFO` 的显示状态设成隐藏，于是 **Explorer 新建的窗口被创建为
不可见**（`IsWindowVisible = False`）——客户端拿到 `204`、以为成功，用户屏幕上什么都没有。

**A/B 实测**（同一台机器、同一条命令，只改这一个布尔值，用 Node `execFile` 各起一次）：

| 选项 | `IsWindowVisible` |
|---|---|
| `windowsHide: true`（现状） | **False** ← 窗口被藏起来 |
| `windowsHide: false` | **True** ✅ |

`windowsHide` 本是给**控制台程序**用的（避免闪出黑框）；把它用在 GUI 打开器上，
副作用就是把窗口藏了。**上游的正解是给 explorer 打开器去掉这个选项。**

（另外 `explorer.exe /select,` 会返回退出码 1，上游注释里已说明这是"委派给现有桌面进程"、
不代表失败——所以 204 也无法暴露这个问题。）

### 修法：宿主自己 spawn（默认只做这一步）

win32 上，宿主半边把 `sessionController.revealPath` 换成自己的实现——
**同一条 `explorer.exe /select,<path>`，唯一区别是 `windowsHide: false`**：

```js
execFile('explorer.exe', ['/select,', path], { windowsHide: false, signal })
```

窗口从一开始就是可见且非最小化的（实测 `IsWindowVisible=True, IsIconic=False`），
**满足"点定位能看到窗口"**。这个改动同时让官方卡片的「在文件资源管理器中显示」一起变好
（两者走同一个方法）。非 win32 平台一律交还原实现。

### 可选：把窗口提到前台（`BRING_TO_FRONT`）

上面那一步之后，窗口是**可见**的，但**不抢前台**——如果浏览器是最大化的，它仍会被挡住。
`lib/index.js` 里有一个开关：

```js
const BRING_TO_FRONT = false   // 需要"跳到最前面"时改成 true
```

打开后，每次 reveal 会再起 `lib/bring-to-front.ps1` 把那个窗口抬到前台。实测有效序列
（顺序有关，`SW_RESTORE` 单独用**不够**）：

```
ShowWindow(hwnd, SW_SHOW=5)          → IsWindowVisible: False → True   ← 关键的一步
ShowWindow(hwnd, SW_SHOWNORMAL=1)    → 恢复被最小化的窗口
ShowWindow(hwnd, SW_RESTORE=9)
BringWindowToTop(hwnd)
keybd_event(VK_MENU down/up)         → 绕前台锁的关键
SetForegroundWindow(hwnd)            → 返回 True
```

**为什么需要 ALT 注入**：Windows 前台锁要求调用方"刚接收过输入"。实测五种手法，
只有 ALT 注入后 `SetForegroundWindow` 才返回 `True`：

| 手法 | 结果 |
|---|---|
| `ShowWindow(SW_RESTORE)` | ❌ 仍被拒 |
| `SetWindowPos(TOPMOST → NOTOPMOST)` | ❌ |
| `AttachThreadInput` + `SetForegroundWindow` | ❌ 返回 False |
| `SwitchToThisWindow` | ❌ |
| **ALT 注入 + `SetForegroundWindow`** | ✅ **返回 True** |

**默认关闭的原因**（2026-09-13 实测后决定）：它只能多买到"抢前台"这一件事，代价却有四项——
每次点击多起一个 PowerShell 进程；多出约 0.35s 的"窗口先冒出来、随后跳一下"；一大坨
COM 枚举 + ALT 注入 + PS 5.1 纯 ASCII 约束；以及多一条会静默失败的路径。窗口既然已经可见，
就先不要它。

helper 的实测细节（保留备查）：

- 在 `TimeoutMs` 内轮询，**用原生 `EnumWindows` + 类名/标题匹配**（类 `CabinetWClass`，标题含文件夹名）。
  `EnumWindows` 自上而下遍历，新开的窗口在 z-order 顶部，第一个命中的就是它
- ⚠️ **绝不用 `Shell.Application.Windows()` 找窗口**：Explorer 还在创建新窗口时对它做 COM 访问会
  **阻塞**——实测有一轮卡了 **6.3 秒**并直接超时。换成 `EnumWindows` 后单轮 **2ms**
- ⚠️ **spawn 参数绝不能加 `detached: true`**：进程会被创建、退出码 0，但脚本**一行都不执行**
  （拿不到控制台句柄，PowerShell 初始化即静默退出）。实测 5 种 spawn 姿势，只有带 `detached` 的失败
- ⚠️ **`.ps1` 必须纯 ASCII**：本机是 Windows PowerShell 5.1，无 BOM 的 UTF-8 脚本会按 ANSI 读，
  中文注释会破坏其后语句的解析（表现为"脚本能跑但关键部分静默不执行"）

**已知未覆盖**：`open`（默认程序打开）走的是 `Invoke-Item`，若它启动的应用窗口同样被
`windowsHide` 影响，本插件不处理（helper 只按文件名匹配资源管理器窗口）。未实测。

## 文件类型图标

卡片左侧 40px 徽标里放 **22px 描边 SVG 图标**（`viewBox="0 0 24 24"`，`stroke="currentColor"`），
收录的扩展名给图标，其余回落成扩展名文字徽标。

收录范围按 **「AI 常产出的交付物」** 来定，不是按操作系统认识的格式全集——
`exe` / `dll` / 字体这类不会出现在交付卡片里，宁可让它们落回文字徽标（文字比通用图标信息量大）。

| 类型 | 收录的扩展名 | 形状 | 颜色 |
|---|---|---|---|
| **PDF** | `pdf` | 折角文件 | `--dsw-static-red-500` |
| **DOC** | `doc` `docx` `dot` `dotx` `rtf` `odt` `txt` `text` `log` `tex` | 文件 + 文字行 | `--dsw-static-blue-500` |
| **表格** | `xls` `xlsx` `xlsm` `xlsb` `csv` `tsv` `ods` | 表格网格 | `--dsw-static-green-500` |
| **PPT** | `ppt` `pptx` `pps` `ppsx` `pot` `potx` `odp` | 演示屏 + 支架 | `--dsw-static-amber-500` |
| **MD** | `md` `markdown` `mdx` | **文字「MD」**（非字形） | `--dsw-static-deepseek-500` |
| **HTML** | `html` `htm` `xhtml` `mht` `mhtml` | `< >` + 斜线 | `--dsw-alias-label-secondary` |
| **图片** | `png` `jpg` `jpeg` `jfif` `gif` `webp` `bmp` `svg` `ico` `tif` `tiff` `heic` `heif` `avif` | 相框（山 + 太阳） | `--dsw-static-green-400` |
| **视频** | `mp4` `m4v` `mov` `mkv` `avi` `webm` `wmv` `flv` `mpg` `mpeg` `mts` `m2ts` | 播放三角 | `--dsw-static-amber-400` |
| **音频** | `mp3` `wav` `m4a` `flac` `ogg` `oga` `opus` `aac` `wma` `aiff` | 双音符 | `--dsw-static-deepseek-400` |
| **压缩包** | `zip` `7z` `rar` `tar` `gz` `tgz` `bz2` `xz` `zst` | 拉链盒 | `--dsw-static-blue-400` |
| **代码** | `json` `jsonl` `ndjson` `yaml` `yml` `xml` `toml` `ini` `cfg` `conf` `properties` `py` `ipynb` `js` `mjs` `cjs` `jsx` **`ts`** `tsx` `vue` `svelte` `sh` `bash` `zsh` `ps1` `bat` `cmd` `sql` `java` `kt` `go` `rs` `rb` `php` `swift` `c` `cc` `cpp` `h` `hpp` `cs` `r` `lua` `pl` `dart` `scala` | 终端窗口 | `--dsw-static-blue-400` |

### 两个刻意的决定

**① MD 走文字徽标而不是字形。** Markdown 那个圆角标（M↓）在 22px 下糊成一团，
两个字母反而一眼认出。这类"文字种类"登记在 `TEXT_KINDS` 里，文字取自 `badgeText`
（所以 `.markdown` 显示成「MARK」）。配色也提亮到品牌蓝，不再是原来的灰。

**② `.ts` 归代码，不归视频。** 它有歧义（MPEG 传输流 vs TypeScript），
但 AI 交付场景下几乎总是 TypeScript；视频那边只认 `.mts`/`.m2ts` 这类无歧义的。

### 配色必须用 alias，不能用 static

**这是一次实测出来的真实缺陷。** 图标原本用 `--dsw-static-*-400/500` 上色，而**静态色板在亮暗两套里
取值完全相同**——那些中浅色本来是给暗色底设计的，放到 `#fafafa` 亮底上，**十一个图标里十个对比度
不足 3:1**（最差的 video 只有 **1.83:1**，几乎看不见）。

改用**语义别名** `--dsw-alias-*`（亮暗各一套、自动跟随主题，如 `state-error-primary` 亮=`red-600`、
暗=`red-400`），只在"别名自己不切换"的四处加暗色覆盖：

```css
.dshdc_badge[data-kind=pdf]{color:var(--dsw-alias-state-error-primary)}     /* 亮 red-600 → 暗 red-400 */
.dshdc_badge[data-kind=sheet]{color:var(--dsw-alias-state-success-primary)} /* 亮暗同值，需覆盖 ↓ */
body[data-ds-dark-theme] .dshdc_badge[data-kind=sheet]{color:var(--dsw-alias-state-success-secondary)}
```

实测对比度（WCAG 对图形元素要求 ≥ 3:1，徽标底色 亮 `#fafafa` / 暗 `#212123`）：

| 类型 | 亮色 | 暗色 |
|---|---|---|
| pdf / doc / md / audio / archive / code | 4.06 – 4.31 ✅ | 4.89 – 6.05 ✅ |
| html | 5.56 ✅ | 10.67 ✅ |
| **sheet / image**（绿） | **2.18** ⚠️ | 8.22 ✅ |
| **ppt / video**（橙） | **2.68** ⚠️ | 8.40 ✅ |

**暗色 11/11 达标。亮色剩 4 个低于 3:1** —— 这是主题色板的硬限制：`green`/`amber` 两族
**没有中间档**，从 `500`（浅）直接跳到 `900`（近黑）。选浅档保色相、选暗档则色相几乎丢失；
实测取舍为**保色相**（图标是辅助线索、旁边就是文件名，且这四个的形状差异很大）。
已用无头 Edge 截图逐类确认：**两套主题下没有任何图标看不见**。

有测试守着这条：**图标配色一律不得使用 `--dsw-static-*`**。

**形状优先，颜色只作辅助**——22px 下形状比颜色好认得多。类型有十一种、可用色族只有六族，
所以颜色做不到"一型一色"；同色类型之间的形状差异都很大（相框 vs 播放键 vs 音符 vs 拉链盒 vs 终端）。

图标是**开发期用无头 Edge 截图自查过**的（`--headless=new --screenshot`）——
形状与对比度这类视觉产物不能只靠坐标推理。

⚠️ **写预览脚本时注意两个坑**，否则会看到假象：

1. **React 的 `className` 要翻成 HTML 的 `class`**，且预览 CSS 必须用**真实类名**（`.dshdc_badge`）。
   错了 CSS 全不生效，图标会渲染成**实心黑块**——看着像字形设计失败，其实是脚本的锅。
2. **主题变量必须挂在"实际用到的容器"上**。我第一版把暗色变量定义在 `body.dark` 却从没给 body
   加那个类，于是"暗色区块"里跑的还是亮色变量——**截图看着没问题，其实根本没验到暗色**。
   跨主题核对一定要确认变量作用域真的生效。

⚠️ `file://` 页面会被 Edge 缓存——改了 HTML 必须**换文件名**或换 user-data-dir，
否则截出来的是旧图（症状：改动前后 PNG 字节数完全一样）。

## 主题适配（亮色 / 暗色）

配色**照抄官方交付卡片**（`dsh-client-ui-deliverables`），因此两种主题下与原生卡片同观感。

关键是搞清 DSH 主题系统的两套机制：

| token 类型 | 行为 | 用法 |
|---|---|---|
| `--dsw-static-*` | **绝对值**，亮暗两套里取值完全相同（`neutral-50` 恒为 `#fafafa`） | 必须靠 `body[data-ds-dark-theme]` **显式改引用** |
| `--dsw-alias-*` | 亮暗**各有一套定义**，自动跟随主题 | 直接用，不需要手动切换 |

所以卡片底色写成与官方一模一样的形态：

```css
.dshdc_root{--dshdc-fill:var(--dsw-static-neutral-50);--dshdc-hover:var(--dsw-static-neutral-100)}
body[data-ds-dark-theme] .dshdc_root{--dshdc-fill:var(--dsw-static-neutral-850);
  --dshdc-hover:var(--dsw-static-neutral-800)}
```

其余颜色一律用 alias token（已逐个核对存在性与亮暗取值）：

| 用途 | token | 亮 → 暗 |
|---|---|---|
| 卡片描边 | `--dsw-alias-border-l1` | `#0000000a` → `#ffffff0f` |
| 按钮描边 | `--dsw-alias-border-l2` | 各有定义 |
| 主文字 | `--dsw-alias-label-primary` | `neutral-bluish-1000` → `neutral-bluish-50` |
| 次文字 | `--dsw-alias-label-secondary` | 各有定义 |
| 徽标 / 焦点 | `--dsw-alias-link` | `deepseek-500` → `deepseek-400` |
| 按钮悬停 | `--dsw-alias-interactive-bg-hover` | `#2631480f` → `#ffffff14` |
| 错误态 | `--dsw-alias-state-error-primary` | `red-600` → `red-400` |

尺寸也对齐官方 `.file`：卡片高 `60px`、圆角 `18px`、图标 `40×40` 圆角 `10px`。

**有测试守着这条**：`零硬编码颜色` 断言去掉 `var(--dsw-*)` 后不残留任何颜色字面量；
`token 必须真实存在` 断言用到的每个 alias token 都在已核实清单内。
（这两个测试是真的抓到过 bug：曾误用不存在的 `--dsw-alias-label-error`，
于是兜底 `#d33` 一直生效且不跟随主题——而写错 token 名是**静默失败**，不会报错。）

**注意**：`lib/client.js` 是客户端 bundle，宿主对它的版本戳是**进程启动时的 nonce**，
所以改完要**重启 `dsh web`** 才会被浏览器取到新内容（不像 `cordis.patch.yml` 那样热加载）。

## 实现要点

- **手写 bundle，零构建、零依赖**。`lib/client.js` 与官方产物同形：
  `window.__ModuleLoader__.load({ id, factory })`；除 `require("react")`（宿主
  `PLATFORM_MODULES` 基线提供）外不 require 任何东西。所以**安装不需要 `pnpm install`**。
- **宿主半边是空实现**（`lib/index.js`）。它存在的唯一理由是让 Loader 有一条启用的
  entry——`client-modules` 只扫描已启用条目，再据 `dsh.client` 声明组装浏览器 bundle。
- **只读 turn data**：从 `owner.turn.data.get("deliverables").presented` 取声明
  （与官方 `presentedForClosing` 同构：`file.seq < owner.seq` 过滤 + 按路径去重）。
  不注册任何 `ConversationNodeDefinition`，因此不与官方争同一份 fold 的所有权。
- **失败即弃权**：`selectCards` 里任何异常都返回 `null` → 回落到原来那行。
  最坏情况是「和装之前一样」，不会把交付行渲染坏。有测试覆盖这条。

## 诊断与日志：只在失败时记录

两个日志文件都**在成功路径上保持静默**。点击是用户主动行为，但"每次成功写一行"依然会
无限增长且没有信息量；真正值得记的是失败与降级：

| 文件（在 `%DSH_HOME%\cache\`） | 写入时机 |
|---|---|
| `dsh-delivery-cards-bring.log` | ① 6 秒内**没找到**目标窗口（`TIMEOUT`）② 找到并显示了但**没拿到前台**（`DEGRADED`）。完全成功不写。 |
| `dsh-delivery-cards-probe.log` | 浏览器侧**只在失败时**上报：非 2xx（`stage:fail`）或 `fetch` 异常（`stage:throw`）。挂载、点击、2xx 全都不上报。 |

有测试守着客户端这条（"诊断上报只在失败路径上"）：两处上报、且不得出现
`mount` / `click` / `result` 阶段——防止有人日后又加回心跳式的挂载日志。

> 早期版本每次卡片挂载写一行，用来确认"浏览器加载的是不是新 bundle"。
> 那是排查阶段的脚手架，问题定位后已移除。

## 测试

```sh
npm test
```

25 项。除了行为断言，还有几条**防回归守卫**，每条都对应一次真实踩坑：

| 守卫 | 来自哪次 |
|---|---|
| 数据读取抛错时必须弃权（不把交付行渲染坏） | `selectCards` 的失败安全 |
| 亮暗色切换必须走官方 token；**零硬编码颜色**；alias token 必须真实存在 | 主题适配 |
| **图标配色不得使用静态色板** | 亮色下 10 个图标对比度不足 3:1 |
| **诊断上报只在失败路径上** | 每次挂载写日志导致无限增长 |
| 失败提示必须带 HTTP 状态码 | 按钮被静默禁用、点了没反应 |
| 不得回归到 `present.host` 前置探测 | 同上 |
| 尺寸对齐官方 `.file`（60px / 18px / 40px） | 视觉一致性 |

## 已知边界

- 只在**存在 `present` 声明**的回合接管；那些回合 better-sidebar 的产出 chips 行会被
  本卡片行替换。（正文里的可点文件路径由官方 `chatFileMentions` 提供，不受影响。）
- 只渲染**卡片**，不重画 chips——这是刻意的：卡片已覆盖交付物，而 chips 点开只能走
  官方侧边栏，回不到 better-sidebar 的面板。
- 读的是 `turn.data` 里的 `deliverables` 键，属**内部结构**；DSH 升级后需复验
  （`presented` 的元素仍需含 `path`/`seq`/`index`）。
