/**
 * dsh-delivery-cards — 浏览器半边（手写 bundle，无需构建）。
 *
 * Bundle 形式与 @deepseek-ai/dsh-client-ui-deliverables 的产物一致：
 *   window.__ModuleLoader__.load({ id, factory })
 * 除 `react`（宿主 PLATFORM_MODULES 基线提供）外不 require 任何东西，
 * 所以既不需要 tsdown 构建，也不需要在 profile 里装任何依赖。
 *
 * ── 它在链上的位置 ──────────────────────────────────────────────────────
 * `conversation.chat.turnTail` 是 chain slot：「第一个 accept 的渲染，其余全跳过」。
 *   · dsh-better-sidebar        priority -1（它自己的注释：-1 runs before the default-0）
 *   · @deepseek-ai/...ui-deliverables  priority 未设 = 0
 * 本插件用 -2 插到最前，但**只在「本轮存在 present 声明」时 accept**：
 *   · 有 present  → 本插件渲染卡片
 *   · 无 present  → 返回 null 弃权，链照旧交给 better-sidebar 那行
 *
 * ── 配色：照抄官方卡片的做法 ────────────────────────────────────────────
 * `--dsw-static-neutral-*` 是**绝对值**，亮/暗色下取值相同（neutral-50 恒为 #fafafa，
 * neutral-850 恒为 #212123），所以主题切换靠 `body[data-ds-dark-theme]` **显式改引用**——
 * 这正是官方 `dsh-client-ui-deliverables` 的写法，本文件照抄同一套。
 * 其余用 `--dsw-alias-*`（border / label / link / interactive-bg-hover / state-error）：
 * 它们在亮暗两套里各定义一次，会自动跟随主题，不需要手动切换。
 *
 * ── 交互的可靠性原则（踩过坑） ──────────────────────────────────────────
 * 曾经在渲染前先探测 `/api/present.host`，探测失败就把两个按钮**禁用**、只在 tooltip
 * 里写原因——结果是「点了完全没反应，界面上没有任何文字」，且探测结果被模块级缓存，
 * 一次瞬时失败会让按钮永久失效。
 * 现在：**不做前置探测、按钮永不禁用**，直接发请求，由服务端裁决；失败时把
 * **HTTP 状态码**写在卡片上。任何残留问题都会立刻可见，而不是静默。
 *
 * ── 数据来源 ────────────────────────────────────────────────────────────
 * 只读 `owner.turn.data.get("deliverables").presented`——这是 ui-deliverables
 * 自己折叠出来、放在 turn data 上的值；dsh-better-sidebar 也读同一个 key。
 * 读取是只读的，不注册任何 ConversationNodeDefinition，因此不会与官方那条
 * 抢同一份 fold 的所有权。
 *
 * ── 安全性 ──────────────────────────────────────────────────────────────
 * select 里任何异常都返回 null → 弃权 → 回落到原来那行。最坏情况是「和装之前
 * 一样」，不会把交付行渲染坏。
 */

window.__ModuleLoader__.load({
	id: "dsh-delivery-cards",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		// ── 宿主路由（官方实现，带鉴权与路径校验） ─────────────────────────
		/**
		 * 认证 POST：?sessionId&seq&index&action=open|reveal
		 * 实现见 `dsh-client-ui-deliverables/lib/index.js` 的 registerPresentOpen：
		 * 校验事件坐标 → 解析主机路径 → `sessionController.openWorkspacePath`。
		 * action=reveal 在 Windows 上走 `explorer.exe /select,`。
		 */
		const PRESENT_OPEN_PATH = "/api/present.open";

		/** 本 bundle 的构建标记：失败记录里带着它，就能确认浏览器加载的是哪个版本。 */
		const BUILD = "v2.8.0-tf";
		// 加载即打标记：页面 console 里
		// document.documentElement.dataset.dshdcBuild 即可确认浏览器在跑哪个版本。
		try { document.documentElement.dataset.dshdcBuild = BUILD; } catch { /* noop */ }
		// 解决的问题：DSH 官方只训练了 DeepSeek Flash 4.1 模型会主动调 present；
		// 其它模型（Kimi/Claude/GPT/Gemini/通义/文心/智谱等）经常忘 present，
		// 导致客户端拿不到交付声明 → better-sidebar -1 抢链显示"本次产出" chips，
		// 用户看不到 60px 带图标的交付卡片。v2.0 在 presented 为空且 produced 启发式
		// 命中时接管渲染——**完全 model 无关**，任何用这个插件的 DSH 用户都受益。
		//
		// 设计纪律（与 skill dsh-delivery-aware 配套）：
		//   1. 启发式默认保守——拿不准就不渲染，宁可少几张卡，不要一堆垃圾。
		//   2. 排除规则优先于包含规则——过程文件不会因为含"final"就被误判。
		//   3. 路径规范化去重——修 OpenViking 记录的 dsh-auto-deliver 双卡 bug
		//      （绝对 vs 相对路径导致同一文件两张卡）。
		//   4. presented 优先——Flash 模型路径完全不变，行为可回退。
		const DEFAULT_EXCLUDE_PATTERNS = [
			/^_.*\.(py|sh|js|ts|ps1|bat|cmd)$/i, // _apply_v1.py / _inspect.py / _scan.py
			/^_tmp_/i,                            // _tmp_xxx
			/^_test_/i,                            // _test_xxx
			/^_inspect/i,                          // _inspect*.py
			/^_apply_/i,                           // _apply_*.py
			/^_find_/i,                            // _find_*.py
			/^_scan_/i,                            // _scan_*.py
			/^_extract_/i,                         // _extract_*.py
			/^_apply/i,                            // _apply*.py（兼容无下划线变体）
			/\.tmp$/i,                             // *.tmp
			/\.bak$/i,                             // *.bak
			/\.swp$/i,                             // *.swp（vim 临时）
			/[/\\]\.tmp[/\\]/i,                    // /.tmp/ 目录
			/[/\\]tmp[/\\]/i,                      // /tmp/ 目录
			/[/\\]debug[/\\]/i,                    // /debug/ 目录
			/[/\\]\.cache[/\\]/i,                  // /.cache/ 目录
		];

		const DEFAULT_INCLUDE_PATTERNS = [
			/[/\\]out[/\\]/i,                      // /out/ 目录
			/[/\\]final[/\\]/i,                    // /final/ 目录
			/[/\\]finalized[/\\]/i,                // /finalized/ 目录
			/[/\\]deliverable[/\\]/i,              // /deliverable/ 目录
			/[/\\]result[/\\]/i,                   // /result/ 目录
			/[/\\]released[/\\]/i,                // /released/ 目录
			/FINAL/i,                               // 含 FINAL
			/终稿/,                                  // 中文"终稿"
			/交付/,                                  // 中文"交付"
			/release/i,                             // 含 release
			/v[1-9]\.\d/,                          // v1.0, v2.1 等版本号
		];

		/** 用户文档格式——命中即视为最终交付。 */
		const USER_DOC_EXTENSIONS = new Set([
			".md", ".markdown",
			".pdf",
			".docx", ".doc", ".rtf",
			".pptx", ".ppt", ".odp", ".ppsx",
			".html", ".htm", ".xhtml",
			".xlsx", ".xls", ".csv", ".tsv",
			".txt", ".text", ".log",
		]);

		/** 兜底最小文件大小：< 5KB 通常是脚本/空文件。 */
		const HEURISTIC_MIN_SIZE = 5 * 1024;

		/** 诊断上报路由（宿主半边登记）。 */
		const PROBE_PATH = "/api/dsh-delivery-cards.probe";

		/**
		 * **只在失败时**向宿主上报一条诊断。必须静默——诊断代码不能干扰被测行为。
		 *
		 * ⚠️ 这里刻意**不记录成功路径**（挂载、点击、2xx）。早先的版本每次卡片挂载都写一行，
		 * 日志会无限增长而绝大多数是没有价值的心跳。失败（异常 / 非 2xx）才是有信息量的，
		 * 而且量级由"出问题"决定，不由"用得多久"决定。
		 * @param payload 可序列化的诊断载荷。
		 */
		function probe(payload) {
			try {
				fetch(PROBE_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ build: BUILD, ...payload }),
				}).catch(() => {});
			} catch {
				// 忽略：探针不能抛错
			}
		}

		// ── 样式：注入一次，全部走 CSS 类（内联样式做不到 :hover 与主题切换） ──
		/** 样式表标识，用于幂等注入。 */
		const STYLE_ID = "dsh-delivery-cards/styles";

		/**
		 * 与官方交付卡片同源的配色与尺寸。
		 *
		 * 变量来源均已核对（`dsh-client-ui-theme` 的 design tokens）：
		 *   --dsw-static-neutral-50  #fafafa   亮色卡片底
		 *   --dsw-static-neutral-100 #f5f5f5   亮色悬停
		 *   --dsw-static-neutral-850 #212123   暗色卡片底
		 *   --dsw-static-neutral-800 #292929   暗色悬停
		 *   --dsw-alias-border-l1 / -l2 / label-primary / label-secondary / link /
		 *   interactive-bg-hover / state-error-primary：亮暗各一套定义，自动跟随主题。
		 *     （示例：label-primary 亮=neutral-bluish-1000 暗=neutral-bluish-50；
		 *      border-l1 亮=#0000000a 暗=#ffffff0f；state-error-primary 亮=red-600 暗=red-400）
		 */
		const CSS = [
			// 亮色：默认引用 neutral-50/100
			".dshdc_root{display:grid;gap:10px;margin-top:4px;grid-template-columns:repeat(2,minmax(0,1fr));",
			"--dshdc-fill:var(--dsw-static-neutral-50);--dshdc-hover:var(--dsw-static-neutral-100)}",
			// 暗色：只改引用，与官方 body[data-ds-dark-theme] .root 的写法一致
			"body[data-ds-dark-theme] .dshdc_root{--dshdc-fill:var(--dsw-static-neutral-850);",
			"--dshdc-hover:var(--dsw-static-neutral-800)}",
			// 单文件占满整行
			".dshdc_root[data-single=true]{grid-template-columns:minmax(0,1fr)}",
			// 卡片本体：尺寸/圆角/描边/内距全部对齐官方 .file
			".dshdc_card{box-sizing:border-box;display:flex;align-items:center;gap:10px;height:60px;",
			"min-width:0;padding:8px 10px;position:relative;overflow:hidden;cursor:pointer;",
			"border:.5px solid var(--dsw-alias-border-l1);border-radius:18px;",
			"background:var(--dshdc-fill);color:var(--dsw-alias-label-primary);",
			"transition:background-color .12s}",
			".dshdc_card:hover{background:var(--dshdc-hover)}",
			".dshdc_card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--dsw-alias-link));",
			"outline-offset:-2px}",
			".dshdc_card[data-static=true]{cursor:default}",
			".dshdc_card[data-static=true]:hover{background:var(--dshdc-fill)}",
			// 文件类型徽标：对齐官方 .fileIcon（40×40、同底色、圆角 10）
			".dshdc_badge{box-sizing:border-box;flex:none;display:grid;place-items:center;",
			"width:40px;height:40px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;",
			"background:var(--dshdc-fill);color:var(--dsw-alias-link);",
			"font-size:11px;font-weight:700;letter-spacing:.02em;overflow:hidden}",
			// 图标：22px 描边字形。stroke=currentColor，颜色由下面的 data-kind 规则给。
			".dshdc_badge svg{width:22px;height:22px;display:block}",
			".dshdc_badge svg path{fill:none;stroke:currentColor;",
			"stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}",
			// 类型配色。
			//
			// ⚠️ 用**语义别名** `--dsw-alias-*`，不要用静态色板 `--dsw-static-*`。
			// 实测：静态色板在亮暗两套里取值**完全相同**，所以拿它给图标上色会出现
			// "亮色模式下六个图标对比度不足"（最差的 video 只有 1.83:1）——
			// 因为 -400/-500 这类中浅色本来是给暗色底用的。
			// 别名则亮暗各一套、自动跟随主题（如 state-error-primary 亮=red-600、暗=red-400）。
			//
			// 对比度（WCAG 图形元素要求 ≥3:1），徽标底色 亮=#fafafa 暗=#212123：
			//   pdf/doc/md/audio/archive/code/html 两套都达标
			//   sheet/image 亮色 green-500 只有 2.18、ppt/video 亮色 amber-600 只有 2.68
			//   —— 这是主题色板的硬限制：green/amber 两族**没有中间档**，
			//      从 500（浅）直接跳到 900（近黑）。选浅档保色相、暗档则色相几乎丢失，
			//      实测取舍为"保色相"，因为图标是辅助线索、旁边就是文件名，且形状差异很大。
			//
			//   pdf   折角文件        doc   文件+文字行      sheet 表格网格
			//   ppt   演示屏          md    文字「MD」       html  < >
			//   image 相框（山+太阳） video 播放三角        audio 音符
			//   archive 拉链盒        code  终端窗口
			".dshdc_badge[data-kind=pdf]{color:var(--dsw-alias-state-error-primary)}",
			".dshdc_badge[data-kind=doc]{color:var(--dsw-alias-link)}",
			".dshdc_badge[data-kind=sheet]{color:var(--dsw-alias-state-success-primary)}",
			".dshdc_badge[data-kind=ppt]{color:var(--dsw-alias-state-warn-label)}",
			// MD 用文字徽标而不是字形——Markdown 那个圆角标在 22px 下太糊，
			// 两个字母反而一眼认出，配色也从灰提到品牌蓝。
			".dshdc_badge[data-kind=md]{color:var(--dsw-alias-link)}",
			".dshdc_badge[data-kind=html]{color:var(--dsw-alias-label-secondary)}",
			".dshdc_badge[data-kind=image]{color:var(--dsw-alias-state-success-primary)}",
			".dshdc_badge[data-kind=video]{color:var(--dsw-alias-state-warn-label)}",
			".dshdc_badge[data-kind=audio]{color:var(--dsw-alias-state-business-primary)}",
			".dshdc_badge[data-kind=archive]{color:var(--dsw-alias-state-business-primary)}",
			".dshdc_badge[data-kind=code]{color:var(--dsw-alias-state-business-primary)}",
			// 暗色覆盖：只给"别名自己不切换"的那些（success-primary / warn-label 亮暗同值）。
			// 其余别名（error/business/link/label-secondary）本来就随主题变，不必重复声明。
			"body[data-ds-dark-theme] .dshdc_badge[data-kind=sheet]{color:var(--dsw-alias-state-success-secondary)}",
			"body[data-ds-dark-theme] .dshdc_badge[data-kind=image]{color:var(--dsw-alias-state-success-secondary)}",
			"body[data-ds-dark-theme] .dshdc_badge[data-kind=ppt]{color:var(--dsw-alias-state-warn-secondary)}",
			"body[data-ds-dark-theme] .dshdc_badge[data-kind=video]{color:var(--dsw-alias-state-warn-secondary)}",
			// 文本区：对齐官方 .details / .fileName
			".dshdc_body{flex:1 1 auto;display:flex;flex-direction:column;justify-content:center;",
			"gap:2px;min-width:0}",
			".dshdc_name{font-size:13px;font-weight:500;line-height:20px;",
			"white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dshdc_sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);",
			"white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dshdc_err{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);",
			"white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			// 动作按钮：常驻可见，不用箭头展开
			".dshdc_actions{flex:none;display:flex;gap:6px}",
			".dshdc_btn{font:inherit;font-size:12px;line-height:20px;padding:2px 10px;white-space:nowrap;",
			"border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:transparent;",
			"color:var(--dsw-alias-label-primary);cursor:pointer;transition:background-color .12s}",
			".dshdc_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".dshdc_btn:disabled{color:var(--dsw-alias-label-secondary);cursor:not-allowed;opacity:.6}",
			// ── travelfusion 富卡片（.tf.json · schema travelfusion-card/v1）──
			// 配色全部走 --dsw-alias-*（亮暗自动跟随）+ color-mix 派生浅底。
			".tfc{background:var(--dshdc-fill);border:.5px solid var(--dsw-alias-border-l1);",
			"border-radius:14px;padding:14px 16px;font-size:13px;line-height:1.5;",
			"color:var(--dsw-alias-label-primary);min-width:0}",
			".tfc .tfc_hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px}",
			".tfc .tfc_title{font-weight:700;font-size:14px}",
			".tfc .tfc_badge{font-size:11px;padding:2px 8px;border-radius:20px;white-space:nowrap;",
			"background:color-mix(in srgb,var(--dsw-alias-link) 12%,transparent);color:var(--dsw-alias-link)}",
			".tfc .tfc_row{display:flex;justify-content:space-between;gap:8px;padding:6px 0;",
			"border-top:.5px solid var(--dsw-alias-border-l1);align-items:center}",
			".tfc .tfc_row:first-of-type{border-top:none}",
			".tfc .tfc_amt{font-weight:700;font-variant-numeric:tabular-nums}",
			".tfc .tfc_flag{font-size:11px;padding:1px 6px;border-radius:6px;margin-left:6px}",
			".tfc .tfc_flag.lcc{background:color-mix(in srgb,var(--dsw-alias-state-warn-label) 14%,transparent);",
			"color:var(--dsw-alias-state-warn-label)}",
			".tfc .tfc_flag.redeye{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);",
			"color:var(--dsw-alias-state-error-primary)}",
			".tfc .tfc_bar{height:5px;border-radius:3px;background:var(--dsw-alias-border-l2);",
			"position:relative;margin:9px 0 4px}",
			".tfc .tfc_bar i{position:absolute;top:-3px;width:10px;height:10px;border-radius:50%;",
			"background:var(--dsw-alias-link);border:2px solid var(--dshdc-fill)}",
			".tfc .tfc_sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:4px}",
			".tfc .tfc_notice{font-size:12.5px;padding:6px 9px;border-radius:8px;margin-top:8px;",
			"background:color-mix(in srgb,var(--dsw-alias-state-warn-label) 12%,transparent);",
			"color:var(--dsw-alias-state-warn-label)}",
			".tfc .tfc_notice[data-level=info]{background:color-mix(in srgb,var(--dsw-alias-link) 10%,transparent);",
			"color:var(--dsw-alias-link)}",
			".tfc .tfc_foot{display:flex;justify-content:space-between;align-items:center;",
			"margin-top:10px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
			".tfc .tfc_act{font-size:12px;padding:4px 11px;border-radius:8px;white-space:nowrap;",
			"border:.5px solid var(--dsw-alias-link);color:var(--dsw-alias-link);font-weight:600}",
			".tfc .tfc_act.tfc_link{cursor:pointer}",
			".tfc .tfc_act.tfc_link:hover{text-decoration:underline}",
			".tfc .tfc_acts{display:flex;gap:6px;align-items:center}",
			".tfc .tfc_hint{font-size:11px;color:var(--dsw-alias-label-secondary);margin-right:4px;font-weight:400}",
			".tfc .tfc_big{font-size:20px;font-weight:800;letter-spacing:-.01em}",
			".tfc .tfc_unit{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:400}",
			".tfc .tfc_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));",
			"gap:8px;margin-top:8px}",
			".tfc .tfc_cell{flex:1;background:var(--dsw-alias-interactive-bg-hover);",
			"border-radius:9px;padding:7px 10px}",
			".tfc .tfc_cell .k{font-size:11px;color:var(--dsw-alias-label-secondary)}",
			".tfc .tfc_cell .v{font-weight:700;font-size:14px;margin-top:2px}",
			".tfc .tfc_steps{list-style:none;margin-top:8px}",
			".tfc .tfc_steps li{display:flex;gap:9px;align-items:center;padding:3px 0;font-size:13px}",
			".tfc .tfc_steps .ic{width:22px;height:22px;border-radius:6px;flex:none;",
			"background:color-mix(in srgb,var(--dsw-alias-link) 10%,transparent);",
			"color:var(--dsw-alias-link);display:inline-flex;align-items:center;justify-content:center;",
			"font-size:12px}",
			".tfc svg{display:block}",
			".tfc svg text{font-family:inherit}",
			// 时区切换 chips（当地/北京/UTC）
			".tfc .tfc_tzs{display:flex;gap:4px;margin:2px 0 8px}",
			".tfc .tfc_tz{font-size:11px;padding:2px 9px;border-radius:12px;cursor:pointer;",
			"border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}",
			".tfc .tfc_tz.on{background:color-mix(in srgb,var(--dsw-alias-link) 14%,transparent);",
			"color:var(--dsw-alias-link);border-color:var(--dsw-alias-link);font-weight:600}",
		].join("");

		/**
		 * 幂等注入样式表：已存在则不动，避免重载时堆积多份。
		 * @returns 注入的 style 元素，或 undefined（无 document 环境）。
		 */
		function ensureStyles() {
			if (typeof document === "undefined") return undefined;
			const selector = `style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`;
			const existing = document.querySelector(selector);
			if (existing !== null) return existing;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-delivery-cards";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return tag;
		}

		// ── 纯函数（与官方 isPresentedFile / basename 同构） ───────────────
		/**
		 * 校验一条交付声明。
		 * @param value 候选值。
		 * @returns 是否为合法声明。
		 */
		function isPresentedFile(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const { path, description } = value;
			return (
				typeof path === "string" &&
				path.trim().length > 0 &&
				(description === undefined || typeof description === "string")
			);
		}

		/**
		 * 路径末段。
		 * @param path 斜杠或反斜杠分隔的路径。
		 * @returns 末段。
		 */
		function basename(path) {
			const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
			return at === -1 ? path : path.slice(at + 1);
		}

		/**
		 * 扩展名徽标文本。
		 * @param name 文件名。
		 * @returns 大写扩展名，最多 4 字符；没有扩展名时返回「文件」。
		 */
		function badgeText(name) {
			const at = name.lastIndexOf(".");
			if (at <= 0 || at === name.length - 1) return "文件";
			return name.slice(at + 1).toUpperCase().slice(0, 4);
		}

		/**
		 * 扩展名 → 图标种类。同族扩展名归一类（ppt/pptx/pps… 都是幕布）。
		 * 未收录的扩展名返回 null，回落成扩展名文字徽标（比一个通用文件图标信息量大）。
		 *
		 * 收录范围按"AI 常产出的交付物"来定，而不是按操作系统认识的格式全集——
		 * exe / dll / 字体这类不会出现在交付卡片里，宁可让它们落回文字徽标。
		 */
		const KIND_BY_EXTENSION = {
			// —— 文档 ——
			pdf: "pdf",
			doc: "doc",
			docx: "doc",
			dot: "doc",
			dotx: "doc",
			rtf: "doc",
			odt: "doc",
			txt: "doc",
			text: "doc",
			log: "doc",
			tex: "doc",
			// —— 演示 ——
			ppt: "ppt",
			pptx: "ppt",
			pps: "ppt",
			ppsx: "ppt",
			pot: "ppt",
			potx: "ppt",
			odp: "ppt",
			// —— 表格 ——
			xls: "sheet",
			xlsx: "sheet",
			xlsm: "sheet",
			xlsb: "sheet",
			csv: "sheet",
			tsv: "sheet",
			ods: "sheet",
			// —— 网页 / 标记 ——
			html: "html",
			htm: "html",
			xhtml: "html",
			mht: "html",
			mhtml: "html",
			md: "md",
			markdown: "md",
			mdx: "md",
			// —— 图片（svg 也是图片；它是矢量图不是代码） ——
			png: "image",
			jpg: "image",
			jpeg: "image",
			jfif: "image",
			gif: "image",
			webp: "image",
			bmp: "image",
			svg: "image",
			ico: "image",
			tif: "image",
			tiff: "image",
			heic: "image",
			heif: "image",
			avif: "image",
			// —— 视频 ——
			mp4: "video",
			m4v: "video",
			mov: "video",
			mkv: "video",
			avi: "video",
			webm: "video",
			wmv: "video",
			flv: "video",
			mpg: "video",
			mpeg: "video",
			// —— 音频 ——
			mp3: "audio",
			wav: "audio",
			m4a: "audio",
			flac: "audio",
			ogg: "audio",
			oga: "audio",
			opus: "audio",
			aac: "audio",
			wma: "audio",
			aiff: "audio",
			// —— 压缩包 ——
			zip: "archive",
			"7z": "archive",
			rar: "archive",
			tar: "archive",
			gz: "archive",
			tgz: "archive",
			bz2: "archive",
			xz: "archive",
			zst: "archive",
			// —— 代码 / 结构化文本 ——
			json: "code",
			jsonl: "code",
			ndjson: "code",
			yaml: "code",
			yml: "code",
			xml: "code",
			toml: "code",
			ini: "code",
			cfg: "code",
			conf: "code",
			properties: "code",
			py: "code",
			ipynb: "code",
			js: "code",
			mjs: "code",
			cjs: "code",
			jsx: "code",
			// `.ts` 有歧义（MPEG 传输流 vs TypeScript）。AI 交付场景下几乎总是
			// TypeScript，所以归代码；视频那边只认 .mts/.m2ts 这类无歧义的。
			ts: "code",
			mts: "video",
			"m2ts": "video",
			tsx: "code",
			vue: "code",
			svelte: "code",
			sh: "code",
			bash: "code",
			zsh: "code",
			ps1: "code",
			bat: "code",
			cmd: "code",
			sql: "code",
			java: "code",
			kt: "code",
			go: "code",
			rs: "code",
			rb: "code",
			php: "code",
			swift: "code",
			c: "code",
			cc: "code",
			cpp: "code",
			h: "code",
			hpp: "code",
			cs: "code",
			r: "code",
			lua: "code",
			pl: "code",
			dart: "code",
			scala: "code",
		}

		/**
		 * 判断一个文件名属于哪种图标。
		 * @param name 文件名（或整个路径——只取末段的扩展名）。
		 * @returns 种类 id，或 null（未收录）。
		 */
		function fileKind(name) {
			const at = name.lastIndexOf(".");
			if (at <= 0 || at === name.length - 1) return null;
			return KIND_BY_EXTENSION[name.slice(at + 1).toLowerCase()] ?? null;
		}

		/**
		 * 图标字形：24×24 viewBox 里的描边路径（`d` 列表）。
		 *
		 * 形状优先——22px 下形状比颜色好认得多，颜色只作辅助线索：
		 *   pdf   折角文件        doc   文件 + 文字行     sheet 表格网格
		 *   ppt   演示屏 + 支架   html  < > 加斜线        image 相框（山 + 太阳）
		 *   video 播放三角        audio 双音符            archive 拉链盒
		 *   code  终端窗口
		 *
		 * `md` 刻意不在这里——它走文字徽标（见 TEXT_KINDS）。
		 * 圆一律用两段弧写成 path，这样 CSS 只需要管一种元素。
		 */
		const ICON_PATHS = {
			pdf: [
				"M6.5 3h6l5 5v12.5a.5.5 0 0 1-.5.5H6.5a.5.5 0 0 1-.5-.5V3.5a.5.5 0 0 1 .5-.5z",
				"M12.5 3v5h5",
			],
			doc: [
				"M6.5 3h6l5 5v12.5a.5.5 0 0 1-.5.5H6.5a.5.5 0 0 1-.5-.5V3.5a.5.5 0 0 1 .5-.5z",
				"M12.5 3v5h5",
				"M8.5 13h6",
				"M8.5 16.5h6",
				"M8.5 20h3",
			],
			sheet: ["M4 5.5h16v13H4z", "M4 10h16", "M9.6 10v8.5", "M14.6 10v8.5"],
			ppt: ["M3.5 4.5h17v11h-17z", "M12 15.5v3.5", "M8.5 20.5h7"],
			html: ["M9.2 7.8l-4.2 4.2 4.2 4.2", "M14.8 7.8l4.2 4.2-4.2 4.2", "M13.4 5.6l-2.8 12.8"],
			image: [
				"M3.5 4.5h17v15h-17z",
				"M3.5 16.6l4.6-4.6 3.1 3.1 3.3-3.3 5.5 5.1",
				"M7 9a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 1 0-2.8 0",
			],
			video: ["M3.5 5.5h17v13h-17z", "M10.3 9.2l4.8 2.8-4.8 2.8z"],
			audio: [
				"M11 17.5V6.5l8-2.2V16",
				"M7 17.5a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
				"M15 16a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
			],
			archive: [
				"M3.5 4.5h17v15h-17z",
				"M12 4.5v15",
				"M9.9 8.4h4.2",
				"M9.9 12h4.2",
				"M9.9 15.6h4.2",
			],
			code: ["M3.5 4.5h17v15h-17z", "M7 9.7l2.6 2.4-2.6 2.4", "M12.4 15h4.4"],
		}

		/**
		 * 走**文字徽标**而不是字形的种类。
		 *
		 * `md` 在这里：Markdown 那个圆角标（M↓）在 22px 下太糊，字母反而一眼认出。
		 * 文字取自 `badgeText`，所以 .markdown 会显示成「MARK」。
		 */
		const TEXT_KINDS = new Set(["md"])

		/**
		 * 生成类型图标。
		 * @param kind ICON_PATHS 的键。
		 * @returns React 元素；未知种类返回 null。
		 */
		function kindIcon(kind) {
			const paths = ICON_PATHS[kind];
			if (paths === undefined) return null;
			return h(
				"svg",
				{ viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" },
				paths.map((d, i) => h("path", { key: i, d })),
			);
		}

		/**
		 * 卡片左侧的徽标：收录的扩展名给图标（`TEXT_KINDS` 除外，那些给文字），
		 * 其余回落成扩展名文字徽标。
		 *
		 * `data-kind` 同时是配色的钩子——颜色写在 CSS 里（`.dshdc_badge[data-kind=…]`），
		 * 不写内联样式，这样主题 token 集中一处、也便于测试盯着。
		 * @param name 文件名。
		 * @returns React 元素。
		 */
		function badgeFor(name) {
			const kind = fileKind(name);
			if (kind === null) return h("div", { className: "dshdc_badge" }, badgeText(name));
			if (TEXT_KINDS.has(kind)) {
				return h("div", { className: "dshdc_badge", "data-kind": kind }, badgeText(name));
			}
			return h("div", { className: "dshdc_badge", "data-kind": kind }, kindIcon(kind));
		}

		/**
		 * 收集本轮收尾之前的所有交付声明，同一路径取更晚的那条。
		 *
		 * 与 ui-deliverables 的 presentedForClosing 同构：按 `file.seq < owner.seq`
		 * 过滤（声明必须早于收尾 assistant 消息），再按路径字面量去重。
		 *
		 * @param owner TurnTailOwnerProps（turn / seq / openFile）。
		 * @returns 交付文件数组，元素含 path / description / seq / index。
		 */
		function presentedFor(owner) {
			const data = owner?.turn?.data?.get?.("deliverables");
			const list = data?.presented;
			if (!Array.isArray(list)) return [];
			const byPath = new Map();
			for (const file of list) {
				if (!isPresentedFile(file)) continue;
				if (typeof file.seq !== "number" || typeof file.index !== "number") continue;
				// owner.seq 是本轮收尾 assistant 的序号；取不到时宁可不筛，避免整行消失。
				if (typeof owner.seq === "number" && !(file.seq < owner.seq)) continue;
				byPath.set(file.path, {
					path: file.path,
					description: file.description,
					seq: file.seq,
					index: file.index,
				});
			}
			return [...byPath.values()];
		}

		/** 接手判定只上报一次（每个页面加载）。 */
		let decisionReported = false;

		/**
		 * **每个页面只上报一次**的接手判定结果。
		 *
		 * 这是"失败才有信息量"原则的**唯一例外**，理由：`selectCards` 弃权是无声的，
		 * 而它一旦误弃权，卡片会整个消失、只剩别人的 chips——这种"功能静默失效"
		 * 正是最该被观测的一类。每次页面加载一行，且有日志上限兜底（宿主侧封顶），
		 * 不会无限增长。
		 * @param raw `presented` 数组的原始长度（-1 表示不是数组；-2 表示读取抛错）。
		 * @param passed 通过校验、真正会渲染的条数。
		 * @param source v2.0：判定来源（"presented" / "fallback"）。用于诊断
		 *   「本轮到底走了哪条路径」——是模型主动 present（Flash），还是客户端启发式
		 *   兜底（非训练模型）。
		 */
		function reportDecision(raw, passed, source) {
			if (decisionReported) return;
			decisionReported = true;
			probe({ stage: "boot", raw, passed, accepted: passed > 0, source: source || "presented" });
		}

		/**
		 * 把任意路径规整为可去重的形式：统一分隔符 + 小写 + 去末尾斜杠。
		 * 用于避免 v1.0.2 时代就记录的「绝对路径 vs cwd 相对路径」导致同一文件
		 * 出现两张卡片的 bug——`dsh-auto-deliver` 文档里点名修过一次但未真正落地。
		 * @param {string} p
		 * @returns {string} 规整后的字符串；非字符串输入返回空串。
		 */
		function normalizePath(p) {
			if (typeof p !== "string" || p.length === 0) return "";
			return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
		}

		/**
		 * v2.0：判断一个 produced 文件是否「看起来像最终交付」。
		 *
		 * 启发式分三段，**排除规则优先**：
		 *   1. 命中默认排除模式 → 立即返回 false（过程文件 / 临时脚本）
		 *   2. 命中默认包含模式（final / 终稿 / 交付 / 路径）→ 立即返回 true
		 *   3. 命中用户文档扩展名（.md / .pdf / .docx / .pptx / .html ...）→ true
		 *   4. 文件 > 5KB → true（KB 级 Python 脚本不是交付）
		 *   5. 都不命中 → false（保守：拿不准就**不**渲染）
		 *
		 * 失败模式（OpenViking 记录）：
		 *   - 包含模式命中但实际是脚本：依赖"路径含 final"被误判 → 排除规则在 step 1 拦住
		 *   - 排除规则过宽：用户可通过配置覆盖（v2.1 计划）
		 *
		 * @param {{ path: string, size?: number }} file
		 * @returns {boolean}
		 */
		function isLikelyDeliverable(file) {
			const path = typeof file?.path === "string" ? file.path : "";
			if (path.length === 0) return false;

			// 阶段 1：排除规则优先
			for (const re of DEFAULT_EXCLUDE_PATTERNS) {
				if (re.test(path)) return false;
			}

			// 阶段 2：包含规则
			for (const re of DEFAULT_INCLUDE_PATTERNS) {
				if (re.test(path)) return true;
			}

			// 阶段 3：用户文档扩展名
			const dot = path.lastIndexOf(".");
			// 处理「.gitignore」「无扩展名」的情况：dot 在 0 位置（隐藏文件）
			if (dot > 0) {
				const ext = path.slice(dot).toLowerCase();
				if (USER_DOC_EXTENSIONS.has(ext)) return true;
			}

			// 阶段 4：大小启发
			const size = typeof file.size === "number" ? file.size : 0;
			if (size > HEURISTIC_MIN_SIZE) return true;

			// 阶段 5：保守默认
			return false;
		}

		/**
		 * v2.0：从 produced 列表里挑出「看起来是最终交付」的文件。
		 *
		 * 与 presentedFor 同构：
		 *   - 校验 file shape（必须有 path / seq / index）
		 *   - 校验 `file.seq < owner.seq`（声明必须早于收尾 assistant 消息）
		 *   - 按规范化路径去重
		 *
		 * 不同点：
		 *   - 数据源是 `produced`（write/edit 工具产出）而非 `presented`（模型显式声明）
		 *   - 走启发式过滤
		 *
		 * @param owner TurnTailOwnerProps。
		 * @returns 候选文件数组。
		 */
		function heuristicFallbackFor(owner) {
			const data = owner?.turn?.data?.get?.("deliverables");
			const list = data?.produced;
			if (!Array.isArray(list)) return [];

			const byPath = new Map();
			for (const file of list) {
				if (!file || typeof file !== "object") continue;
				if (typeof file.path !== "string" || file.path.length === 0) continue;
				if (typeof file.seq !== "number" || typeof file.index !== "number") continue;
				// owner.seq 缺失时宁可不筛，避免整行消失。
				if (typeof owner.seq === "number" && !(file.seq < owner.seq)) continue;
				if (!isLikelyDeliverable(file)) continue;

				const norm = normalizePath(file.path);
				if (byPath.has(norm)) continue; // 兜底也要去重（修 dsh-auto-deliver 双卡 bug）
				byPath.set(norm, {
					path: file.path,
					description: typeof file.description === "string" ? file.description : "",
					seq: file.seq,
					index: file.index,
				});
			}
			return [...byPath.values()];
		}

		/**
		 * 链上的选择器：presented 优先（v1.0.2 行为）；presented 为空时走
		 * produced 启发式兜底（v2.0 新增）；都不命中则弃权让位给 better-sidebar。
		 *
		 * 弃权是"整行回落给别人"的强动作——一旦因为数据形状不认识而误弃权，
		 * 表现是**卡片整个消失、只剩别人的 chips**，且完全无声。所以这里每页只上报
		 * 一次判定结果（`presented` 原始条数 vs 通过校验的条数、最终是否接手），
		 * 这是排查"卡片为什么没出现"最直接的一条证据。
		 * @param owner TurnTailOwnerProps。
		 * @returns `{ files }` 或 null。
		 */
		function selectCards(owner) {
			const dbg = (s) => {
				try { document.documentElement.dataset.dshdcLast = s; } catch { /* noop */ }
			};
			try {
				const data = owner?.turn?.data?.get?.("deliverables");
				const rawPresented = data?.presented;
				const rawProduced = data?.produced;
				const files = presentedFor(owner);
				dbg(`presented=${Array.isArray(rawPresented) ? rawPresented.length : -1}`
					+ ` files=${files.length}`);
				if (files.length > 0) {
					// v1.0.2 行为保持：presented 优先
					reportDecision(Array.isArray(rawPresented) ? rawPresented.length : -1, files.length);
					return { files };
				}
				// v2.0：presented 为空时尝试 produced 兜底（非训练模型路径）
				const fallback = heuristicFallbackFor(owner);
				dbg(`presented=0 fallback=${fallback.length}`);
				if (fallback.length > 0) {
					reportDecision(
						Array.isArray(rawPresented) ? rawPresented.length : -1,
						fallback.length,
						"fallback", // 标记这是 fallback 路径，便于诊断
					);
					return { files: fallback };
				}
				// 都空：弃权
				dbg("abstain: both empty");
				reportDecision(
					Array.isArray(rawPresented) ? rawPresented.length : -1,
					0,
				);
				return null;
			} catch (error) {
				dbg(`select-error: ${String(error?.message || error).slice(0, 120)}`);
				reportDecision(-2, -2);
				return null;
			}
		}

		/**
		 * 原生动作的认证 URL。
		 * @param sessionId 当前查看的 Session。
		 * @param seq 交付事件序号。
		 * @param index 事件内文件下标。
		 * @param action open=默认程序，reveal=资源管理器。
		 * @returns 请求 URL。
		 */
		function nativeUrl(sessionId, seq, index, action) {
			const query = new URLSearchParams({
				sessionId,
				seq: String(seq),
				index: String(index),
				action,
			});
			return `${PRESENT_OPEN_PATH}?${query}`;
		}

		/**
		 * 动作失败时给用户一句能看懂的话——**必须带状态码**，否则无法定位。
		 * @param status HTTP 状态码；0 表示请求根本没发出去。
		 * @returns 中文说明。
		 */
		function describeFailure(status) {
			if (status === 0) return "请求没有发出（网络或连接层失败）";
			if (status === 400) return "请求坐标无效：会话或声明缺失（HTTP 400）";
			if (status === 401 || status === 403) return `没有权限执行该操作（HTTP ${status}）`;
			if (status === 404) return "文件已不存在或已被移走（HTTP 404）";
			if (status === 409) return "此主机没有可用的桌面（HTTP 409）";
			if (status === 422) return "无法验证该文件的主机路径（HTTP 422）";
			return `操作失败（HTTP ${status}）`;
		}

		/**
		 * 动作成功时的说明。
		 *
		 * 「定位」这一条必须写清「窗口可能开在后台」：实测（以及 dsh-desktop 的
		 * issue #953）确认，Windows 的前台锁会让 `explorer.exe /select,` 打开的
		 * 资源管理器窗口**不抢焦点**，开在浏览器后面。功能是成功的，但用户体感是
		 * 「点了没反应」——所以必须把这件事说出来，而不是静默回到原描述。
		 * @param action open 或 reveal。
		 * @returns 中文说明。
		 */
		function describeSuccess(action) {
			return action === "open"
				? "已交给默认程序打开"
				: "已在资源管理器中定位 · 窗口可能开在后台，Alt+Tab 可见";
		}

		/**
		 * 一张交付卡片。
		 *
		 * 交互约定：
		 *   · 点卡片空白处  → 侧边栏预览（openFile）
		 *   · 「打开」按钮  → 宿主默认程序打开
		 *   · 「定位」按钮  → 电脑资源管理器中显示
		 * 两个按钮**常驻可见且永不禁用**（只在请求进行中临时禁用），不做折叠、不用箭头展开。
		 *
		 * @param props file / openFile / onOpen / onReveal / phase
		 * @returns React 元素。
		 */
		function DeliveryCard(props) {
			const { file, openFile, onOpen, onReveal, phase } = props;
			const name = basename(file.path);
			const busy = phase === "opening" || phase === "revealing";

			const button = (label, handler, title) =>
				h(
					"button",
					{
						type: "button",
						className: "dshdc_btn",
						disabled: busy,
						title,
						onClick: (event) => {
							event.stopPropagation();
							if (busy) return;
							handler();
						},
					},
					label,
				);

			const failed = typeof phase === "string" && phase.startsWith("error:");
			const succeeded = typeof phase === "string" && phase.startsWith("ok:");
			const subtitle = failed
				? describeFailure(Number(phase.slice(6)))
				: succeeded
					? describeSuccess(phase.slice(3))
					: phase === "opening"
						? "正在用默认程序打开…"
						: phase === "revealing"
							? "正在资源管理器中定位…"
							: file.description ?? badgeText(name);

			return h(
				"div",
				{
					className: "dshdc_card",
					title: file.path,
					role: "button",
					tabIndex: 0,
					"data-delivery-card": true,
					onClick: () => openFile(file.path),
					onKeyDown: (event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							openFile(file.path);
						}
					},
				},
				badgeFor(name),
				h(
					"div",
					{ className: "dshdc_body" },
					h("div", { className: "dshdc_name" }, name),
					h("div", { className: failed ? "dshdc_err" : "dshdc_sub" }, subtitle),
				),
				h(
					"div",
					{ className: "dshdc_actions" },
					button("打开", () => onOpen(file), "用默认程序打开"),
					button("定位", () => onReveal(file), "在文件资源管理器中显示"),
				),
			);
		}

		/**
		 * 交付卡片行。
		 *
		 * `sessionId` 走**标准 prop**（官方 Deliverables 也是这么拿的），
		 * 只把 `inject` 的返回值当兜底——反过来会把真值覆盖成 undefined。
		 *
		 * @param props matched / sessionId / injectedSessionId / openFile。
		 * @returns React 元素或 null。
		 */
		function DeliveryCards(props) {
			const { matched, openFile } = props;
			const sessionId = props.sessionId ?? props.injectedSessionId;
			const files = Array.isArray(matched?.files) ? matched.files : [];
			const [phases, setPhases] = React.useState({});

			React.useEffect(() => {
				ensureStyles();
			}, []);

			if (files.length === 0) return null;

			// 拿不到会话坐标就明说，不要留下两个点了没反应的按钮。
			if (typeof sessionId !== "string" || sessionId.length === 0) {
				return h(
					"div",
					{ className: "dshdc_root", "data-single": "true", "data-delivery-cards-row": true },
					h(
						"div",
						{ className: "dshdc_card", "data-static": "true" },
						h("div", { className: "dshdc_badge" }, "!"),
						h(
							"div",
							{ className: "dshdc_body" },
							h("div", { className: "dshdc_name" }, `${files.length} 个交付文件`),
							h(
								"div",
								{ className: "dshdc_err" },
								"缺少会话标识（sessionId）：「打开」「定位」不可用，请点卡片在侧边栏预览",
							),
						),
					),
				);
			}

			const run = (file, action) => {
				const setPhase = (value) =>
					setPhases((previous) => ({ ...previous, [file.path]: value }));
				setPhase(action === "open" ? "opening" : "revealing");
				const url = nativeUrl(sessionId, file.seq, file.index, action);
				fetch(url, { method: "POST" })
					.then((response) => {
						// 只上报失败。成功不上报——见 probe() 的说明。
						if (!response.ok) {
							probe({ stage: "fail", action, url, status: response.status });
						}
						setPhase(
							response.ok ? `ok:${action}` : `error:${response.status}`,
						);
					})
					.catch((error) => {
						probe({ stage: "throw", action, url, message: String(error) });
						setPhase("error:0");
					});
			};

			return h(
				"div",
				{
					className: "dshdc_root",
					"data-single": files.length === 1 ? "true" : undefined,
					"data-delivery-cards-row": true,
				},
				files.map((file) => {
					const tf = (() => {
						try {
							return parseTf(file);
						} catch (err) {
							try {
								document.documentElement.dataset.dshdcParseErr =
									String(err).slice(0, 120);
							} catch { /* noop */ }
							return null;
						}
					})();
					if (!tf) {
						try {
							document.documentElement.dataset.dshdcFile = JSON.stringify({
								p: String(file.path).slice(-44),
								d: typeof file.description,
								dl: typeof file.description === "string"
									? file.description.length : -1,
								head: typeof file.description === "string"
									? file.description.slice(0, 40) : "",
							});
						} catch { /* noop */ }
					}
					if (tf) {
						// travelfusion 富卡片：全宽渲染
						return h(TfCard, {
							key: `${file.seq}:${file.index}:${file.path}`,
							card: tf, file, openFile,
						});
					}
					return h(DeliveryCard, {
						key: `${file.seq}:${file.index}:${file.path}`,
						file,
						openFile,
						onOpen: (target) => run(target, "open"),
						onReveal: (target) => run(target, "reveal"),
						phase: phases[file.path],
					});
				}),
			);
		}

		// ── travelfusion 富卡片（.tf.json · description 携带卡片 JSON）────────
		// 数据通道：agent 调 present 时把服务端编排好的 meta.card（紧凑 JSON）放进
		// description——客户端读不到工件内容，description 是唯一天然随行的通道。
		// 解析失败 → 回退普通文件卡（永不白屏）。
		const TF_SCHEMA = "travelfusion-card/v1";
		// 卡片自取通道：agent 用 <id>.tf.json 命名工件（id 由服务端暂存区签发），
		// description 若随行则直接用；否则按文件名 id 从服务端拉取（CORS 已放开）。
		const TF_BASE = "http://192.168.100.1:8900";

		/**
		 * 尝试把一个交付文件解析为 travelfusion 卡片。
		 * description 携带完整 JSON → 直接返回；
		 * 否则文件名形如 <12位id>.tf.json → 返回 pending 卡（TfCard 异步自取）。
		 * @param {{path:string, description?:string}} file
		 * @returns 卡片对象或 null。
		 */
		function parseTf(file) {
			if (typeof file?.path !== "string" || !/\.tf\.json$/i.test(file.path)) return null;
			const raw = typeof file.description === "string" ? file.description.trim() : "";
			if (raw.startsWith("{")) {
				try {
					const card = JSON.parse(raw);
					if (card?.schema === TF_SCHEMA && typeof card.type === "string") return card;
				} catch { /* fallthrough to id channel */ }
			}
			const m = /([0-9a-f]{12})\.tf\.json$/i.exec(file.path);
			if (m) {
				return { schema: TF_SCHEMA, type: "pending", id: m[1],
					title: "卡片加载中…" };
			}
			return null;
		}

		/** ISO 当地时间 → "MM-DD HH:MM"。 */
		function tfShortTime(iso) {
			if (typeof iso !== "string" || iso.length < 16) return iso || "";
			const base = iso.slice(5, 16).replace("T", " ");
			return iso.endsWith("Z") ? `${base} UTC` : base;
		}

		/** 分钟 → "XhYm"。 */
		function tfDur(min) {
			if (min == null) return "";
			const hh = Math.floor(min / 60);
			const mm = min % 60;
			return hh > 0 ? `${hh}h${String(mm).padStart(2, "0")}m` : `${mm}m`;
		}

		/** 红眼/LCC 标注。 */
		function tfFlags(p) {
			const flags = [];
			if (p.lcc) flags.push(h("span", { className: "tfc_flag lcc" }, "LCC"));
			if (p.red_eye) flags.push(h("span", { className: "tfc_flag redeye" }, "红眼"));
			return flags;
		}

		/** SVG 示意地图：城表坐标投影，零瓦片零网络。 */
		function tfMap(map) {
			if (!map || !Array.isArray(map.points) || map.points.length < 2) return null;
			const W = 400, H = 104, P = 36;
			const lats = map.points.map((p) => p.lat);
			const lngs = map.points.map((p) => p.lng);
			const minLat = Math.min(...lats), maxLat = Math.max(...lats);
			const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
			const sx = (maxLng - minLng) || 1, sy = (maxLat - minLat) || 1;
			const px = (p) => P + ((p.lng - minLng) / sx) * (W - 2 * P);
			const py = (p) => H - P * 0.7 - ((p.lat - minLat) / sy) * (H - 2 * P * 0.7);
			const bySeq = new Map(map.points.map((p) => [p.seq, p]));
			const children = [
				h("rect", { x: 0, y: 0, width: W, height: H, rx: 10,
					fill: "var(--dsw-alias-interactive-bg-hover)" }),
			];
			for (const line of map.lines || []) {
				const a = bySeq.get(line.from), b = bySeq.get(line.to);
				if (!a || !b) continue;
				const x1 = px(a), y1 = py(a), x2 = px(b), y2 = py(b);
				const cx = (x1 + x2) / 2, cy = Math.min(y1, y2) - 22;
				children.push(h("path", {
					d: `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`,
					stroke: "var(--dsw-alias-link)", "stroke-width": 2.2,
					fill: "none", "stroke-dasharray": "6 5",
					"stroke-linecap": "round", opacity: 0.85,
				}));
				if (line.label) {
					children.push(h("text", {
						x: cx, y: cy - 6, fill: "var(--dsw-alias-label-secondary)",
						"font-size": 11, "text-anchor": "middle",
					}, line.label));
				}
			}
			map.points.forEach((p, i) => {
				children.push(h("circle", { cx: px(p), cy: py(p), r: 5.5,
					fill: i === map.points.length - 1
						? "var(--dsw-alias-state-success-primary)"
						: i === 0 ? "var(--dsw-alias-link)"
						: "var(--dsw-alias-state-warn-label)" }));
				children.push(h("text", { x: px(p), y: py(p) + 20,
					fill: "var(--dsw-alias-label-secondary)", "font-size": 12,
					"text-anchor": "middle" }, `${p.seq ? p.seq + " " : ""}${p.name}`));
			});
			return h("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%",
				role: "img", "aria-label": "线路示意" }, children);
		}

		/** notices[] 渲染。 */
		function tfNotices(card) {
			return (card.notices || []).map((n, i) =>
				h("div", { key: i, className: "tfc_notice", "data-level": n.level },
					`${n.level === "warn" ? "⚠️ " : "ℹ️ "}${n.text}`));
		}

		/** price.select / price.single。 */
		function tfPriceBody(card) {
			const p = card.payload || {};
			const rows = (p.prices || []).map((row, i) =>
				h("div", { key: i, className: "tfc_row" },
					h("div", null,
						h("span", { style: { fontWeight: 600 } },
							row.recommended ? "✓ " : "",
							row.airline_name && row.airline_name !== row.airline_iata
								? `${row.airline_name} `
								: `${row.airline_iata ?? "航班"} `),
						h("span", { style: { color: "var(--dsw-alias-label-secondary)",
							fontSize: 12 } }, row.flight_no ?? ""),
						h("span", { style: { color: "var(--dsw-alias-label-secondary)",
							fontSize: 12, marginLeft: 8 } }, tfShortTime(row.dep_local)),
						tfFlags(row),
						row.stop_city
							? h("span", { className: "tfc_flag lcc" }, `经停·${row.stop_city}`)
							: null,
						row.cabin_class && row.cabin_class !== "经济舱"
							? h("span", { style: { color: "var(--dsw-alias-label-secondary)",
								fontSize: 11, marginLeft: 6 } }, row.cabin_class)
							: null),
					h("span", { className: "tfc_amt" },
						`${row.currency === "CNY" ? "¥" : row.currency ?? ""}${row.amount ?? ""}`),
				));
			const b = card.meta?.baseline;
			const baseline = b ? [
				h("div", { className: "tfc_bar" },
					h("i", { style: { left: `${Math.min(90, Math.max(2, b.vs_min ?? 2))}%` } })),
				h("div", { className: "tfc_sub" },
					b.vs_min === 0 ? "价格处于 90 天最低位 · 可入手"
						: `高于 90 天最低（¥${b.min_cny}）约 ${b.vs_min}%`),
			] : [];
			const typeBadge = p.price_type === "calibrated" ? "官方校准价" : "参考缓存价";
			return [
				h("div", { className: "tfc_hd" },
					h("span", { className: "tfc_title" }, card.title),
					h("span", { className: "tfc_badge" },
						card.scene?.trip_type === "incentive" ? "奖励旅游" : typeBadge)),
				h("div", null, rows),
				...baseline,
				...tfNotices(card),
				h("div", { className: "tfc_foot" },
					h("span", null, `${typeBadge} · ${card.meta?.cache === "hit" ? "缓存" : "实时"}`),
					h("span", { className: "tfc_acts" }, tfActs(card))),
			];
		}

		/** ISO + IANA 时区 + 展示模式 → "MM-DD HH:MM"。tz 缺失回退 UTC 标注。 */
		function tfTimeIn(iso, tz, tm) {
			if (!iso) return "—";
			if (tm === "utc" || !tz) {
				return tfShortTime(iso);            // tfShortTime 已为 Z 结尾自带 UTC 标注
			}
			const zone = tm === "bj" ? "Asia/Shanghai" : tz;
			try {
				return new Intl.DateTimeFormat("zh-CN", {
					timeZone: zone, month: "2-digit", day: "2-digit",
					hour: "2-digit", minute: "2-digit", hour12: false,
				}).format(new Date(iso));
			} catch {
				return tfShortTime(iso);
			}
		}

		/** 动作槽：带 url → 真按钮（新窗口打开外部复核页）；无 url → 胶囊 + 可见提示。
		 *  消灭静默死按钮：任何动作要么可点，要么明说怎么用（回复确认即执行）。 */
		function tfActs(card) {
			const acts = card.actions || [];
			if (!acts.length) return null;
			const kids = [];
			let needHint = false;
			for (const a of acts) {
				if (a.url) {
					kids.push(h("span", {
						key: a.id || a.label,
						className: "tfc_act tfc_link",
						onClick: (e) => { e.stopPropagation(); window.open(a.url, "_blank", "noopener"); },
					}, a.label));
				} else {
					needHint = true;
					kids.push(h("span", { key: a.id || a.label, className: "tfc_act" }, a.label));
				}
			}
			return needHint
				? [h("span", { key: "hint", className: "tfc_hint" }, "回复确认即执行")].concat(kids)
				: kids;
		}

		/** status（时区切换有状态，故为组件；状态自持，点击 chip 即重渲染）。 */
		function TfStatus(props) {
			const { card } = props;
			const [tm, setTm] = React.useState("local");
			const p = card.payload || {};
			const dep = p.timeline?.dep ?? {};
			const arr = p.timeline?.arr ?? {};
			const pick = (o) => o?.actual
				? { iso: o.actual, tag: "实际" }
				: o?.estimated
					? { iso: o.estimated, tag: "预计" }
					: { iso: o.scheduled_utc, tag: "计划" };
			const d = pick(dep);
			const a = pick(arr);
			const delay = p.dep_delay_min;
			const pill = delay != null && delay > 0
				? h("span", { className: "tfc_flag redeye" }, `+${delay}min`)
				: delay != null
					? h("span", { className: "tfc_flag", style: { color: "var(--dsw-alias-state-success-primary)" } }, "准点")
					: null;
			const chip = (id, label) => h("span", {
				className: "tfc_tz" + (tm === id ? " on" : ""),
				onClick: (e) => { e.stopPropagation(); setTm(id); },
			}, label);
			const T = (t) => (t && /^\d+$/.test(String(t)) ? `T${t}` : t);
			const kvBits = [
				p.dep_terminal && p.arr_terminal
					? `${T(p.dep_terminal)} → ${T(p.arr_terminal)}` : null,
				p.baggage ? `行李 ${p.baggage}` : null,
			].filter(Boolean);
			const layovers = (p.layovers || []).map((l, i) =>
				h("div", { key: i, className: "tfc_notice", "data-level": "info" },
					`ℹ️ 经停 ${l.at} · 等待 ${l.wait_min ?? "?"}min`));
			return [
				h("div", { className: "tfc_hd" },
					h("span", { className: "tfc_title" }, `✈️ ${card.title}`),
					h("span", { className: "tfc_badge" },
						p.airline_name && p.airline_name !== p.airline_iata
							? p.airline_name : p.airline_iata ?? "")),
				h("div", { className: "tfc_tzs" },
					chip("local", "当地时间"), chip("bj", "北京时间"), chip("utc", "UTC")),
				h("div", { className: "tfc_grid" },
					h("div", { className: "tfc_cell" },
						h("div", { className: "k" }, `起飞 · ${d.tag}`),
						h("div", { className: "v" },
							tfTimeIn(d.iso, p.dep_tz, tm), " ", pill)),
					h("div", { className: "tfc_cell" },
						h("div", { className: "k" }, `到达 · ${a.tag}`),
						h("div", { className: "v" }, tfTimeIn(a.iso, p.arr_tz, tm))),
					p.duration_min ? h("div", { className: "tfc_cell" },
						h("div", { className: "k" }, "总飞行时长"),
						h("div", { className: "v" }, tfDur(p.duration_min))) : null),
				...layovers,
				kvBits.length ? h("div", { className: "tfc_sub" }, kvBits.join(" ｜ ")) : null,
				h("div", { className: "tfc_foot" },
					h("span", null, (card.meta?.sources || [])
						.map((x) => x.provider).join(" · ") || ""),
					h("span", { className: "tfc_acts" }, tfActs(card))),
			];
		}

		/** route.cn / route.intl / route.map。 */
		/** 真实路线形状 SVG（shape[lat,lng] 点序列 → 投影折线 + 端点标注）。 */
		function tfShapeSvg(map, shape) {
			if (!Array.isArray(shape) || shape.length < 2) return tfMap(map);
			const W = 400, H = 118;
			const lats = shape.map((s) => s[0]);
			const lngs = shape.map((s) => s[1]);
			const minLat = Math.min(...lats), maxLat = Math.max(...lats);
			const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
			const sx = (maxLng - minLng) || 1, sy = (maxLat - minLat) || 1;
			const P = 26;
			const px = (lng) => P + ((lng - minLng) / sx) * (W - 2 * P);
			const py = (lat) => H - P * 0.8 - ((lat - minLat) / sy) * (H - 2 * P * 0.8);
			const d = shape.map((s, i) => `${i === 0 ? "M" : "L"}${px(s[1]).toFixed(1)},${py(s[0]).toFixed(1)}`).join(" ");
			const kids = [
				h("rect", { x: 0, y: 0, width: W, height: H, rx: 10,
					fill: "var(--dsw-alias-interactive-bg-hover)" }),
				h("path", { d, stroke: "var(--dsw-alias-link)", "stroke-width": 2.4,
					fill: "none", "stroke-linejoin": "round", "stroke-linecap": "round",
					opacity: 0.9 }),
			];
			const ends = [{ lat: shape[0][0], lng: shape[0][1],
				name: map?.points?.[0]?.name || "起点", c: "var(--dsw-alias-link)" },
				{ lat: shape[shape.length - 1][0], lng: shape[shape.length - 1][1],
					name: map?.points?.[1]?.name || "终点",
					c: "var(--dsw-alias-state-success-primary)" }];
			for (const e of ends) {
				kids.push(h("circle", { cx: px(e.lng), cy: py(e.lat), r: 5,
					fill: e.c }));
				kids.push(h("text", { x: px(e.lng), y: py(e.lat) - 10,
					fill: "var(--dsw-alias-label-secondary)", "font-size": 12,
					"text-anchor": "middle" }, e.name));
			}
			if (map?.lines?.[0]?.label) {
				kids.push(h("text", { x: W - 10, y: 16,
					fill: "var(--dsw-alias-label-secondary)", "font-size": 11,
					"text-anchor": "end" }, map.lines[0].label));
			}
			return h("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%",
				role: "img" }, kids);
		}

		/** 静态地图组件：img 盖 SVG 兜底；static_urls 三档 zoom 可切换（−/＋）。 */
		function TfStaticMap(props) {
			const { map, shape, staticUrl, staticUrls } = props;
			const levels = (staticUrls && typeof staticUrls === "object")
				? ["out", "fit", "in"].map((k) => staticUrls[k]).filter(Boolean)
				: (staticUrl ? [staticUrl] : []);
			const [idx, setIdx] = React.useState(Math.max(0,
				Math.min(1, levels.length - 1)));
			const svg = tfShapeSvg(map, shape);
			if (!levels.length) return svg;
			const step = (d) => (e) => { e.stopPropagation();
				setIdx(Math.max(0, Math.min(levels.length - 1, idx + d))); };
			return h("div", { style: { position: "relative",
					aspectRatio: "400 / 170",
					backgroundColor: "var(--dsw-alias-interactive-bg-hover)",
					borderRadius: 10, overflow: "hidden" } },
				h("div", { style: { position: "absolute", inset: 0,
						display: "flex", alignItems: "center",
						justifyContent: "center" } }, svg),
				h("img", { src: levels[idx], alt: "", loading: "lazy",
					onError: (e) => { e.currentTarget.remove(); },
					style: { position: "absolute", left: 0, top: 0,
						width: "100%", height: "100%", objectFit: "cover" } }),
				levels.length > 1 ? h("div", { style: { position: "absolute",
						right: 6, top: 6, display: "flex", gap: 4 } },
					h("span", { key: "out", className: "tfc_tz",
						style: { opacity: idx > 0 ? 1 : 0.35 },
						onClick: step(-1) }, "−"),
					h("span", { key: "in", className: "tfc_tz",
						style: { opacity: idx < levels.length - 1 ? 1 : 0.35 },
						onClick: step(1) }, "＋")) : null);
		}

		function tfRouteBody(card) {
			const p = card.payload || {};
			const isCn = card.type !== "route.intl";
			const parts = [
				h("div", { className: "tfc_hd" },
					h("span", { className: "tfc_title" }, `🚗 ${card.title}`),
					h("span", { className: "tfc_badge" }, isCn ? "高德" : "Google")),
			];
			if (!isCn) {
				parts.push(h("div", { className: "tfc_big" },
					p.distance_km, h("span", { className: "tfc_unit" },
						` km · ${p.duration_min ?? "?"}min`)));
				const lines = (p.transit_lines || []).map((line, i) =>
					h("li", { key: i }, h("span", { className: "ic" }, "›"), line));
				if (lines.length) {
					parts.push(h("ul", { className: "tfc_steps" }, lines));
				}
			} else {
				parts.push(h("div", { className: "tfc_big" },
					p.distance_km, h("span", { className: "tfc_unit" }, " km")));
				const cell = (k, v) => h("div", { className: "tfc_cell" },
					h("div", { className: "k" }, k), h("div", { className: "v" }, v));
				parts.push(h("div", { className: "tfc_grid" },
					cell("总耗时", p.duration_text
						|| (p.duration_min != null ? `${p.duration_min}min` : "—")),
					cell("高速费", p.tolls_cny != null ? `¥${p.tolls_cny}` : "—"),
					cell("高速占比", p.highway_pct != null ? `${p.highway_pct}%` : "—")));
				if (p.ev_plan && p.ev_plan.charge_stops_needed > 0) {
					parts.push(h("div", { className: "tfc_sub" },
						`EV：建议中途充电 ${p.ev_plan.charge_stops_needed} 次`));
				}
				const attr = (p.attractions || []).map((a, i) =>
					h("div", { key: i, className: "tfc_row" },
						h("span", null, `🏛️ ${a.name}`),
						h("span", { className: "tfc_flag" },
							(a.address || "").slice(0, 14))));
				if (attr.length) {
					parts.push(h("div", { className: "tfc_sub",
						style: { width: "100%" } }, "沿途/目的地景点"));
					parts.push(...attr);
				}
				const segs = (p.segments || []).filter((s) => s && s.name);
				if (segs.length) {
					parts.push(h("div", { className: "tfc_sub",
						style: { width: "100%" } }, "路段明细"));
					parts.push(...segs.map((s, i) =>
						h("div", { key: i, className: "tfc_row" },
							h("span", null, s.name),
							h("span", { className: "tfc_flag" },
								`${s.km ?? "?"} km${s.pct != null ? ` · ${s.pct}%` : ""}`))));
				} else if ((p.roads || []).some((r) => r.km > 0)) {
					parts.push(h("div", { className: "tfc_sub",
						style: { width: "100%" } }, "主要路段"));
					parts.push(...(p.roads || []).map((r, i) =>
						h("div", { key: i, className: "tfc_row" },
							h("span", null, r.name),
							h("span", { className: "tfc_flag" }, `${r.km} km`))));
				}
				const spots = (p.attractions || []).filter((a) => a && a.name);
				if (spots.length) {
					parts.push(h("div", { className: "tfc_sub",
						style: { width: "100%" } }, "沿途看点"));
					parts.push(...spots.map((a, i) =>
						h("div", { key: i, className: "tfc_row" },
							h("span", null, a.name),
							a.note ? h("span", { style: {
								color: "var(--dsw-alias-label-secondary)",
								fontSize: 12 } }, a.note) : null)));
				}
			}
			// 地图仅在有真实折线（shape）时渲染；两点虚线弧没有信息量，不再回退
			if (Array.isArray(p.shape) && p.shape.length >= 2) {
				parts.push(h(TfStaticMap, { map: p.map, shape: p.shape,
					staticUrl: p.static_url, staticUrls: p.static_urls }));
			}
			parts.push(h("div", { className: "tfc_foot" },
				h("span", null, (card.meta?.sources || [])
					.map((x) => x.provider).join(" · ") || ""),
				h("span", { className: "tfc_acts" }, tfActs(card))));
			return parts;
		}

		/** weather。 */
		function tfWeatherBody(card) {
			const p = card.payload || {};
			const range = Array.isArray(p.t_range) ? p.t_range : [];
			return [
				h("div", { className: "tfc_hd" },
					h("span", { className: "tfc_title" }, card.title),
					h("span", { className: "tfc_badge" }, p.layer ?? "")),
				h("div", { className: "tfc_big" },
					range[0] != null ? `${range[0]}–${range[1]}` : "—",
					h("span", { className: "tfc_unit" }, " °C")),
				p.precip_mm != null
					? h("div", { className: "tfc_sub" }, `降水 ${p.precip_mm}mm`)
					: null,
				...tfNotices(card),
			];
		}

		/** quota。 */
		function tfQuotaBody(card) {
			const rows = (card.payload?.rows || []).map((r, i) => {
				const pct = r.limit && r.remaining != null
					? Math.round((r.remaining / r.limit) * 100) : null;
				return h("div", { key: i, className: "tfc_row" },
					h("span", null, r.provider,
						r.tier === "paid" ? h("span", { className: "tfc_flag lcc" }, "paid") : null),
					pct != null ? h("span", { className: "tfc_bar", style: { flex: 1, margin: "0 10px" } },
						h("i", { style: { left: `${Math.max(2, pct - 2)}%` } })) : null,
					h("span", { className: "tfc_amt" },
						r.remaining != null ? `${r.remaining}/${r.limit ?? "∞"}` : "paygo"));
			});
			return [h("div", { className: "tfc_hd" },
				h("span", { className: "tfc_title" }, "额度仪表盘")), h("div", null, rows)];
		}

		/** confirm / empty / 兜底。 */
		function tfGenericBody(card) {
			const parts = [
				h("div", { className: "tfc_hd" },
					h("span", { className: "tfc_title" }, card.title),
					card.scene?.trip_type ? h("span", { className: "tfc_badge" },
						card.scene.trip_type) : null),
			];
			if (card.payload?.hint) {
				parts.push(h("div", { style: { fontSize: 13 } }, card.payload.hint));
			}
			parts.push(...tfNotices(card));
			const acts = tfActs(card);
			if (acts) {
				parts.push(h("div", { className: "tfc_foot" },
					h("span", { className: "tfc_acts" }, acts)));
			}
			return parts;
		}

		/** 类型分派。 */
		function tfBody(card) {
			switch (card.type) {
				case "price.select":
				case "price.single":
					return tfPriceBody(card);
				case "status":
					return h(TfStatus, { card });
				case "itinerary":
					return h(TfItinerary, { card });
				case "recommend":
					return h(TfRecommend, { card });
				case "validate":
					return h(TfValidate, { card });
				case "route.cn":
				case "route.intl":
				case "route.map":
					return tfRouteBody(card);
				case "weather":
					return tfWeatherBody(card);
				case "quota":
					return tfQuotaBody(card);
				case "plan.days":
					return h(TfPlanDays, { card });
				case "hotel.select":
					return h(TfHotelSelect, { card });
				case "flight.rec":
					return h(TfFlightRec, { card });
				default:
					return tfGenericBody(card);
			}
		}

		/**
		 * travelfusion 富卡片。解析失败的 .tf.json 会先经过 parseTf 过滤，
		 * 走不到这里——所以这里假定 card 已合法。
		 */
		function TfCard(props) {
			const { card, file, openFile } = props;
			const isPending = card.type === "pending";
			const [live, setLive] = React.useState(isPending ? null : card);
			React.useEffect(() => {
				let alive = true;
				if (isPending && card.id) {
					fetch(`${TF_BASE}/cards/${card.id}`)
						.then((r) => (r.ok ? r.json()
							: Promise.reject(new Error(`HTTP ${r.status}`))))
						.then((c) => {
							if (alive && c && c.schema === TF_SCHEMA) setLive(c);
						})
						.catch(() => {
							if (alive) setLive({ schema: TF_SCHEMA, type: "empty",
								title: "卡片已过期或不可达",
								payload: { hint: "服务端暂存 2 小时；重新查询即可重新生成" } });
						});
				}
				return () => { alive = false; };
			}, [card.id, isPending]);
			const c = live || card;
			const [copied, setCopied] = React.useState(false);
			let body;
			try {
				body = tfBody(c);
			} catch (err) {
				body = h("div", { className: "tfc_sub" },
					`卡片渲染异常（${String(err).slice(0, 80)}）——原文件不受影响`);
			}
			// 点击 → 外部人工复核直链（服务端拼好 URL 的第一个 review_* action：
			// FR24 班表 / FlightAware——作用是复核信息真实性，不是复看卡片内容）。
			// 无 review 链接的卡（行程/价格/天气/配额/空态）点击不动作：
			// 绝不误触 confirm 类 action；/view 复制品语义已废弃，不再作为点击目标。
			const review = (c.actions || []).find((a) =>
				a && typeof a.url === "string"
				&& String(a.id || "").startsWith("review_"));
			const open = review
				? () => window.open(review.url, "_blank", "noopener")
				: null;
			// 一键复制：取服务端纯文本分享摘要（微信/备忘录可直接粘贴）
			const doCopy = async (e) => {
				e.stopPropagation();
				try {
					let text = "";
					if (c.id) {
						const r = await fetch(`${TF_BASE}/cards/${c.id}/text`);
						text = r.ok ? await r.text() : "";
					}
					if (!text) {
						text = (file.description
							&& typeof file.description === "string"
							&& file.description.startsWith("{"))
							? JSON.stringify(JSON.parse(file.description), null, 2)
							: JSON.stringify(c, null, 2);
					}
					if (navigator.clipboard && navigator.clipboard.writeText) {
						await navigator.clipboard.writeText(text);
					} else {
						const ta = document.createElement("textarea");
						ta.value = text;
						document.body.appendChild(ta);
						ta.select();
						document.execCommand("copy");
						ta.remove();
					}
					setCopied(true);
					setTimeout(() => setCopied(false), 1600);
				} catch { /* 复制失败静默 */ }
			};
			const copyBar = h("div", {
				style: { display: "flex", justifyContent: "flex-end",
					marginTop: 6 },
			}, h("span", {
				className: "tfc_tz" + (copied ? " on" : ""),
				onClick: doCopy,
				title: "复制纯文本摘要（可直接粘贴给他人）",
			}, copied ? "✓ 已复制" : "⧉ 复制文本"));
			return h("div", {
				className: "tfc",
				style: { gridColumn: "1 / -1" },
				role: open ? "button" : undefined,
				tabIndex: open ? 0 : undefined,
				"data-tf-card": c.type,
				title: open ? "点击打开外部复核页（FR24 / FlightAware）" : undefined,
				onClick: open || undefined,
				onKeyDown: open ? (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						open();
					}
				} : undefined,
			}, body, copyBar);
		}

		// ── 注册 ───────────────────────────────────────────────────────────
		const inject = ["slots"];

		/**
		 * 挂到 turnTail 链上，priority 低于 better-sidebar，故先被询问。
		 * @param ctx 浏览器半边上下文。
		 */
/**
 * 0.1.7 直取通道：从本轮 tool-call 快照里提取
 * ① present 声明（.tf.json 路径 → description/id 通道）
 * ② 任何工具输出里内嵌的 travelfusion-card/v1 JSON（meta.card 直取）
 * 模型零参与：工具返回即卡片。
 */
		function tfExtract(rows) {
			const decls = [];
			const cards = [];
			const seen = new Set();
			const tryCards = (s) => {
				if (typeof s !== "string") return [];
				// 护栏（2026-10-02 卡死事故）：卡片 JSON 只有几 KB；超大字符串
				// （会话导出、日志、base64）一旦内含标记，下面 while 循环对每次
				// 命中都从 lastIndexOf("{") 扫到串尾——O(n·k) 平方级，直接把
				// 主线程卡死几十秒（实测 23.4s，见 trace）。256KB 以上的串
				// 不可能承载合法卡片，直接跳过。
				if (s.length > 262144) return [];
				const out = [];
				let idx = 0;
				while (true) {
					const i = s.indexOf('"travelfusion-card/v1"', idx);
					if (i < 0) break;
					const start = s.lastIndexOf("{", i);
					if (start < 0) { idx = i + 1; continue; }
					let depth = 0, inStr = false, esc = false, done = -1;
					for (let k = start; k < s.length; k++) {
						const ch = s[k];
						if (inStr) {
							if (esc) esc = false;
							else if (ch === "\\") esc = true;
							else if (ch === '"') inStr = false;
							continue;
						}
						if (ch === '"') inStr = true;
						else if (ch === "{") depth++;
						else if (ch === "}") {
							depth--;
							if (depth === 0) {
								try {
									const c = JSON.parse(s.slice(start, k + 1));
									if (c && c.schema === TF_SCHEMA) out.push(c);
								} catch { /* skip */ }
								done = k + 1;
								break;
							}
						}
					}
					idx = done > 0 ? done : i + 1;
				}
				return out;
			};
			const walk = (node, depth) => {
				if (!node || typeof node !== "object" || depth > 8) return;
				if (seen.has(node)) return;
				seen.add(node);
				if (Array.isArray(node)) {
					for (const x of node) walk(x, depth + 1);
					return;
				}
				for (const [k, v] of Object.entries(node)) {
					if (k === "path" && typeof v === "string"
						&& /\.tf\.json$/i.test(v)) {
						decls.push({
							path: v,
							description: typeof node.description === "string"
								? node.description : undefined,
						});
					}
					if (typeof v === "string"
						&& v.includes('"travelfusion-card/v1"')) {
						for (const c of tryCards(v)) cards.push(c);
					}
					walk(v, depth + 1);
				}
			};
			walk(rows, 0);
			return { decls, cards };
		}

		/**
		 * 0.1.7 turnTail list 条目：props = {turn, seq, sessionId, useChat, openFile}。
		 * 数据源 = 本轮 tool-call 行（present 工具调用的入参含卡片 JSON）。
		 * 无内容 return null（0.1.7 语义：条目自己决定显隐）。
		 */
		function TfTurnTail(props) {
			const { turn, useChat, openFile } = props;
			const [recent, setRecent] = React.useState(null);
			const source = useChat((chat) =>
				chat.nodes.turnDataSource(turn.turn, "tool-call"));
			const rows = React.useSyncExternalStore(
				source.subscribe,
				source.getSnapshot,
				source.getSnapshot,
			);
			// 时间窗自取：本轮（最近 15 分钟）暂存的卡片必然在窗口内，
			// 模型零参与。CORS 已在服务端放开。
			React.useEffect(() => {
				let alive = true;
				const since = Math.floor(Date.now() / 1000) - 900;
				fetch(`${TF_BASE}/cards/recent?since=${since}`)
					.then((r) => (r.ok ? r.json()
						: Promise.reject(new Error(`HTTP ${r.status}`))))
					.then((list) => {
						if (alive && Array.isArray(list)) setRecent(list);
					})
					.catch(() => { /* 服务不可达：静默回退其他通道 */ });
				return () => { alive = false; };
			}, []);
			const extracted = React.useMemo(() => tfExtract(rows), [rows]);
			const entries = React.useMemo(() => {
				const list = [];
				const keyOf = (c) => c.id || c.title || "";
				const push = (c) => {
					if (c && c.schema === TF_SCHEMA
						&& !list.some((x) => keyOf(x) === keyOf(c))) list.push(c);
				};
				for (const c of recent || []) push(c);
				for (const c of extracted.cards) push(c);
				for (const file of extracted.decls) {
					let c = null;
					try { c = parseTf(file); } catch { c = null; }
					if (c) { push(c); continue; }
					const m = /([0-9a-f]{12})\.tf\.json$/i.exec(file.path);
					if (m) push({ schema: TF_SCHEMA, type: "pending", id: m[1],
						title: "卡片加载中…" });
				}
				return list;
			}, [recent, extracted]);
			if (entries.length === 0) return null;
			return h("div", {
				style: { display: "grid", gap: 10, width: "100%" },
				"data-tf-turn-tail": "",
			}, entries.map((c, i) => h(TfCard, {
				key: (c.id || c.title || "tf") + ":" + i,
				card: c,
				file: { path: (c.id || "travelfusion") + ".tf.json",
					description: JSON.stringify(c) },
				openFile,
			})));
		}

		/** itinerary 全程卡：垂直时间线 + 固定锚点 deadline + 全程地图。 */
		function TfItinerary(props) {
			const { card, openFile } = props;
			const p = card.payload || {};
			const ICON = { flight: "✈️", rail: "🚄", drive: "🚗" };
			const legs = (p.legs || []).map((leg, i) => {
				const fixed = leg.fixed;
				return h("div", { key: i, style: { display: "grid",
					gridTemplateColumns: "34px 1fr auto", gap: "0 10px",
					padding: "8px 0",
					borderBottom: ".5px solid var(--dsw-alias-border-l1)" } },
					h("div", { style: { fontSize: 20, textAlign: "center" } },
						ICON[leg.mode] || "🚗"),
					h("div", null,
						h("div", { style: { fontWeight: 600 } },
							`${leg.from} → ${leg.to}`,
							fixed ? h("span", { className: "tfc_flag",
								style: { marginLeft: 6 } }, "固定") : null),
						h("div", { className: "tfc_sub" },
							`${tfShortTime(leg.depart)} → ${tfShortTime(leg.arrive)}`,
							leg.duration_min
								? ` · ${tfDur(leg.duration_min)}` : ""),
						leg.must_arrive_by
							? h("div", { className: "tfc_sub",
								style: { color: "var(--dsw-alias-state-warn-label)" } },
								`⏰ ${leg.to} 需 ${tfShortTime(leg.must_arrive_by)} 前抵达`
								+ (leg.latest_depart
									? `（最迟 ${tfShortTime(leg.latest_depart)} 从 ${leg.from} 出发）`
									: ""))
							: null),
					h("div", { style: { textAlign: "right" } },
						leg.buffer_min != null
							? h("span", { className: "tfc_flag" },
								`提前 ${leg.buffer_min}min`) : null));
			});
			const mapSvg = (p.map && p.map.points.length >= 2)
				? tfMap(p.map) : null;
			return [
				h("div", { className: "tfc_hd" },
					h("span", { className: "tfc_title" }, "🗺️ 全程行程"),
					h("span", { className: "tfc_badge" },
						p.span_min ? tfDur(p.span_min) : "")),
				...legs,
				...(card.notices || []).map((n, i) => h("div", {
					key: "n" + i, className: "tfc_notice",
					"data-level": n.level || "info" },
					(n.level === "warn" ? "⚠️ " : "ℹ️ ") + (n.text || ""))),
				mapSvg ? h("div", { style: { marginTop: 10 } }, mapSvg) : null,
			];
		}

		/** recommend 汇总卡：结构化推荐结论（服务端排版，模型只给数据）。 */
		function TfRecommend(props) {
			const { card } = props;
			const p = card.payload || {};
			const rows = (p.picks || []).map((pk, i) =>
				h("div", { key: i, style: { display: "grid",
					gridTemplateColumns: "34px 1fr", gap: "0 10px", padding: "8px 0",
					borderBottom: ".5px solid var(--dsw-alias-border-l1)" } },
					h("div", { style: { fontSize: 18, textAlign: "center",
						fontWeight: 700,
						color: i === 0 ? "var(--dsw-alias-link)"
							: "var(--dsw-alias-label-secondary)" } },
						String(i + 1)),
					h("div", null,
						h("div", { style: { fontWeight: 600 } },
							pk.title || pk.label || "方案",
							i === 0 ? h("span", { className: "tfc_flag",
								style: { marginLeft: 6 } }, "首推") : null),
						pk.reason ? h("div", { className: "tfc_sub" },
							pk.reason) : null,
						(Array.isArray(pk.tags) && pk.tags.length)
							? h("div", { className: "tfc_sub" },
								pk.tags.map((x, j) => h("span", {
									key: j, className: "tfc_flag",
									style: { marginRight: 4 } }, x)))
							: null)));
			const notes = (card.notices || []).map((n, i) => h("div", {
				key: "n" + i, className: "tfc_sub" }, `· ${n.text || ""}`));
			return [
				h("div", { className: "tfc_hd" },
					h("span", { className: "tfc_title" }, `🧭 ${card.title}`),
					p.total_cost_text
						? h("span", { className: "tfc_badge" }, p.total_cost_text)
						: null),
				...rows,
				...(notes.length ? [h("div", { className: "tfc_sub",
					style: { marginTop: 8 } }, notes)] : []),
			];
		}

		/** plan.days 每日行程安排卡：按日分组景点（时长/时段/门票标注）。 */
		function TfPlanDays(props) {
			const { card } = props;
			const p = card.payload || {};
			const days = (p.days || []).map((d, i) =>
				h("div", { key: i, style: { padding: "8px 0",
					borderBottom: ".5px solid var(--dsw-alias-border-l1)" } },
					h("div", { style: { fontWeight: 600, marginBottom: 4 } },
						d.label || `Day ${i + 1}`),
					(d.items || []).map((it, j) =>
						h("div", { key: j, style: { display: "flex",
							gap: 8, padding: "2px 0" } },
							h("span", { className: "tfc_flag",
								style: { minWidth: 52, textAlign: "center" } },
								it.time || `#${j + 1}`),
							h("span", null, it.name,
								it.minutes ? h("span", { className: "tfc_sub" },
									` · 约${it.minutes}分钟`) : null,
								it.opentime ? h("span", { className: "tfc_sub" },
									` · 开放 ${it.opentime}`) : null,
								it.ticket_text ? h("span", { className: "tfc_sub" },
									` · ${it.ticket_text}`) : null))),
					d.note ? h("div", { className: "tfc_sub" }, d.note) : null));
			const notes = (card.notices || []).map((n, i) =>
				h("div", { key: "n" + i, className: "tfc_sub" }, `· ${n.text || ""}`));
			return [
				h("div", { className: "tfc_hd" },
					h("span", { className: "tfc_title" }, `🗓️ ${card.title}`)),
				...days,
				...(notes.length ? [h("div", { className: "tfc_sub",
					style: { marginTop: 8 } }, notes)] : []),
			];
		}

		/** hotel.select 酒店推荐卡：参考价 + 地址标签 + 归因预订链接。 */
		function TfHotelSelect(props) {
			const { card } = props;
			const p = card.payload || {};
			const rows = (p.hotels || []).map((ht, i) =>
				h("div", { key: i, style: { display: "grid",
					gridTemplateColumns: "34px 1fr", gap: "0 10px", padding: "8px 0",
					borderBottom: ".5px solid var(--dsw-alias-border-l1)" } },
					h("div", { style: { fontSize: 18, textAlign: "center",
						fontWeight: 700,
						color: i === 0 ? "var(--dsw-alias-link)"
							: "var(--dsw-alias-label-secondary)" } },
						String(i + 1)),
					h("div", null,
						h("div", { style: { fontWeight: 600 } },
							ht.name || "酒店",
							ht.star ? h("span", { className: "tfc_sub",
								style: { marginLeft: 6 } }, `★${ht.star}`) : null),
						ht.price_note ? h("div", { className: "tfc_sub" },
							ht.price_note) : null,
						ht.commute ? h("div", { className: "tfc_sub" },
							`🚗 以线定房通勤：${ht.commute}`) : null,
						ht.address ? h("div", { className: "tfc_sub" },
							ht.address) : null,
						(Array.isArray(ht.tags) && ht.tags.length)
							? h("div", null, ht.tags.slice(0, 4).map((t, j) =>
								h("span", { key: j, className: "tfc_flag",
									style: { marginRight: 4 } }, t)))
							: null,
						ht.booking_url ? h("a",
							{ href: ht.booking_url, target: "_blank",
								rel: "noreferrer",
								style: { fontSize: 12,
									color: "var(--dsw-alias-link)" } },
							"去预订 →") : null)));
			const notes = (card.notices || []).map((n, i) =>
				h("div", { key: "n" + i, className: "tfc_sub" }, `· ${n.text || ""}`));
			return [
				h("div", { className: "tfc_hd" },
					h("span", { className: "tfc_title" }, `🏨 ${card.title}`)),
				...rows,
				...(notes.length ? [h("div", { className: "tfc_sub",
					style: { marginTop: 8 } }, notes)] : []),
			];
		}

		/** flight.rec 航班推荐卡：候选班次行 + 官网核验按钮（tfActs 渲染 actions）。 */
		function TfFlightRec(props) {
			const { card } = props;
			const p = card.payload || {};
			const rows = (p.flights || []).map((f, i) =>
				h("div", { key: i, style: { display: "grid",
					gridTemplateColumns: "34px 1fr auto", gap: "0 10px",
					padding: "8px 0", alignItems: "center",
					borderBottom: ".5px solid var(--dsw-alias-border-l1)" } },
					h("div", { style: { fontSize: 18, textAlign: "center",
						fontWeight: 700,
						color: i === 0 ? "var(--dsw-alias-link)"
							: "var(--dsw-alias-label-secondary)" } },
						String(i + 1)),
					h("div", null,
						h("div", { style: { fontWeight: 600 } }, f.no || "班次",
							f.craft ? h("span", { className: "tfc_sub",
								style: { marginLeft: 6 } }, f.craft) : null),
						h("div", { className: "tfc_sub" },
							`${f.dep_t || "?"} → ${f.arr_t || "?"}`)),
					f.note ? h("div", { className: "tfc_sub" }, f.note) : null));
			const acts = tfActs(card);
			const notes = (card.notices || []).map((n, i) =>
				h("div", { key: "n" + i, className: "tfc_sub" }, `· ${n.text || ""}`));
			return [
				h("div", { className: "tfc_hd" },
					h("span", { className: "tfc_title" }, `✈️ ${card.title}`)),
				...rows,
				...(acts.length ? [h("div", { className: "tfc_foot" },
					h("span", { className: "tfc_acts" }, acts))] : []),
				...(notes.length ? [h("div", { className: "tfc_sub",
					style: { marginTop: 8 } }, notes)] : []),
			];
		}

		/** validate 可行性校验卡：违规清单 + 覆盖说明（advisory 不阻断）。 */
		function TfValidate(props) {
			const { card } = props;
			const p = card.payload || {};
			const rows = (p.violations || []).map((v, i) =>
				h("div", { key: i,
					style: { padding: "6px 10px", margin: "6px 0",
						borderLeft: v.level === "error"
							? "3px solid var(--dsw-alias-state-error-primary)"
							: "3px solid var(--dsw-alias-state-warn-label)" } },
					(v.level === "error" ? "⛔ " : "⚠️ ") + v.text));
			const checked = h("div", { className: "tfc_sub" },
				`已核验 ${p.checked || 0} 个景点 · 时间窗 `
				+ `${(p.window || [])[0]}–${(p.window || [])[1]}`);
			const notes = (card.notices || [])
				.filter((n) => (n.text || "").includes("知识库未覆盖"))
				.map((n, i) => h("div", { key: "n" + i,
					className: "tfc_sub" }, `ℹ️ ${n.text}`));
			const ok = !(p.violations || []).length
				? h("div", { className: "tfc_notice ok",
					style: { padding: "8px 10px", marginTop: 6 } },
					"✅ 未发现可行性问题")
				: null;
			return [
				h("div", { className: "tfc_hd" },
					h("span", { className: "tfc_title" }, `🧮 ${card.title}`)),
				checked,
				...(rows.length ? rows : [ok]),
				...notes,
			];
		}

		function apply(ctx) {
			ensureStyles();
			// 0.1.7 契约（照抄 dsh-codex-connect 实船范式）：
			// turnTail 是 list slot —— id/order 必填、没有 select、
			// 条目组件自己决定显隐（无内容 return null）。
			ctx.slots.inject("conversation.chat.turnTail", () =>
				ctx.slots.register(
					{
						name: "conversation.chat.turnTail",
						id: "dsh-delivery-cards-tf",
						order: 10,
					},
					TfTurnTail,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.parseTf = parseTf;
		exports.tfMap = tfMap;
		exports.tfBody = tfBody;
		exports.presentedFor = presentedFor;
		exports.heuristicFallbackFor = heuristicFallbackFor;
		exports.isLikelyDeliverable = isLikelyDeliverable;
		exports.normalizePath = normalizePath;
		exports.selectCards = selectCards;
		exports.reportDecision = reportDecision;
		exports.badgeText = badgeText;
		exports.fileKind = fileKind;
		exports.kindIcon = kindIcon;
		exports.textKinds = TEXT_KINDS;
		exports.badgeFor = badgeFor;
		exports.nativeUrl = nativeUrl;
		exports.describeFailure = describeFailure;
		exports.describeSuccess = describeSuccess;
		exports.css = CSS;
		return module.exports;
	},
});
