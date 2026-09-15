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
		const BUILD = "v2.0.0";
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
			try {
				const data = owner?.turn?.data?.get?.("deliverables");
				const rawPresented = data?.presented;
				const rawProduced = data?.produced;
				const files = presentedFor(owner);
				if (files.length > 0) {
					// v1.0.2 行为保持：presented 优先
					reportDecision(Array.isArray(rawPresented) ? rawPresented.length : -1, files.length);
					return { files };
				}
				// v2.0：presented 为空时尝试 produced 兜底（非训练模型路径）
				const fallback = heuristicFallbackFor(owner);
				if (fallback.length > 0) {
					reportDecision(
						Array.isArray(rawPresented) ? rawPresented.length : -1,
						fallback.length,
						"fallback", // 标记这是 fallback 路径，便于诊断
					);
					return { files: fallback };
				}
				// 都空：弃权
				reportDecision(
					Array.isArray(rawPresented) ? rawPresented.length : -1,
					0,
				);
				return null;
			} catch (error) {
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
				files.map((file) =>
					h(DeliveryCard, {
						key: `${file.seq}:${file.index}:${file.path}`,
						file,
						openFile,
						onOpen: (target) => run(target, "open"),
						onReveal: (target) => run(target, "reveal"),
						phase: phases[file.path],
					}),
				),
			);
		}

		// ── 注册 ───────────────────────────────────────────────────────────
		const inject = ["slots"];

		/**
		 * 挂到 turnTail 链上，priority 低于 better-sidebar，故先被询问。
		 * @param ctx 浏览器半边上下文。
		 */
		function apply(ctx) {
			ensureStyles();
			ctx.slots.inject("conversation.chat.turnTail", () =>
				ctx.slots.register(
					{
						name: "conversation.chat.turnTail",
						select: selectCards,
						priority: -2,
						registrant: "dsh-delivery-cards",
						// 用独立键名返回，绝不覆盖标准 prop `sessionId`。
						inject: (sessionId) => ({ injectedSessionId: sessionId }),
					},
					DeliveryCards,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
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
