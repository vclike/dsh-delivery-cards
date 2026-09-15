/**
 * dsh-delivery-cards 浏览器半边的纯函数测试（零依赖、不渲染）。
 *
 * lib/client.js 是手写 bundle，顶层调用 window.__ModuleLoader__.load 注册工厂。
 * 这里用一个最小 shim 捕获工厂，再用桩 require 注入假 React——只测纯逻辑
 * （数据筛选与选择器安全性），不触及渲染。
 *
 * 运行：node --test test/helpers.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let definition;
globalThis.window = {
	__ModuleLoader__: {
		load(value) {
			definition = value;
		},
	},
};

await import("../lib/client.js");

assert.equal(definition?.id, "dsh-delivery-cards", "bundle 必须以包名注册");

// 最小 React 桩。createElement 返回可断言的对象（而不是 null），
// 这样图标这种"返回元素"的纯函数也能在 Node 里被检查。
const stubReact = {
	createElement: (type, props, ...children) => ({
		type,
		props: {
			...(props ?? {}),
			children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
		},
	}),
	useState: () => [null, () => {}],
	useEffect: () => {},
};
const mod = definition.factory((request) => {
	if (request === "react") return stubReact;
	throw new Error(`unexpected require: ${request}`);
});

const { presentedFor, heuristicFallbackFor, isLikelyDeliverable, normalizePath, selectCards, badgeText, fileKind, kindIcon, textKinds, badgeFor, css } = mod;

/** 造一个 owner：presented 列表挂在 turn.data 的 deliverables 键上。 */
function makeOwner(presented, seq = 100, produced) {
	return {
		seq,
		turn: {
			data: {
				get: (key) => {
					if (key === "deliverables") return { presented, produced: produced ?? [] };
					return undefined;
				},
			},
		},
		openFile: () => {},
	};
}

test("badgeText 取大写扩展名，无扩展名回落到「文件」", () => {
	assert.equal(badgeText("行业研究报告.md"), "MD");
	assert.equal(badgeText("a.docx"), "DOCX");
	assert.equal(badgeText("archive.tar.gz"), "GZ");
	assert.equal(badgeText("noext"), "文件");
	assert.equal(badgeText("trailing."), "文件");
});

test("presentedFor 只收 seq 早于收尾消息的声明", () => {
	const owner = makeOwner(
		[
			{ path: "out/a.md", description: "早", seq: 10, index: 0 },
			{ path: "out/b.png", description: "晚", seq: 200, index: 0 },
		],
		100,
	);
	const files = presentedFor(owner);
	assert.deepEqual(files.map((f) => f.path), ["out/a.md"]);
});

test("presentedFor 同路径取更晚的那条声明", () => {
	const owner = makeOwner(
		[
			{ path: "out/a.md", description: "旧的", seq: 10, index: 0 },
			{ path: "out/a.md", description: "新的", seq: 20, index: 0 },
		],
		100,
	);
	const files = presentedFor(owner);
	assert.equal(files.length, 1);
	assert.equal(files[0].description, "新的");
	assert.equal(files[0].seq, 20);
});

test("presentedFor 丢弃非法声明，缺数据时返回空数组", () => {
	const owner = makeOwner([
		null,
		"nope",
		{ path: "  ", seq: 1, index: 0 },
		{ path: "ok.md", seq: 1, index: 0, description: 42 },
		{ path: "good.md", description: "合法", seq: 1, index: 2 },
		{ path: "no-seq.md", description: "缺 seq" },
	]);
	const files = presentedFor(owner);
	assert.deepEqual(files.map((f) => f.path), ["good.md"]);
	assert.equal(files[0].index, 2);

	assert.deepEqual(presentedFor(makeOwner(undefined)), []);
	assert.deepEqual(presentedFor({ seq: 1, turn: { data: { get: () => undefined } } }), []);
	assert.deepEqual(presentedFor(undefined), []);
});

test("selectCards 有声明时接手，无声明时弃权", () => {
	const withFiles = selectCards(makeOwner([{ path: "out/a.md", seq: 1, index: 0 }]));
	assert.ok(withFiles);
	assert.equal(withFiles.files.length, 1);

	assert.equal(selectCards(makeOwner([])), null);
	assert.equal(selectCards(undefined), null);
});

test("selectCards 在数据读取抛错时弃权（绝不把交付行渲染坏）", () => {
	const boom = {
		seq: 5,
		turn: {
			data: {
				get() {
					throw new Error("turn data exploded");
				},
			},
		},
	};
	assert.equal(selectCards(boom), null);
});

test("selectCards 在 owner.seq 缺失时不筛（宁可不筛也不让整行消失）", () => {
	// 显式传 null 而不是 undefined——undefined 会触发默认参数，拿不到“缺失”的场景。
	const owner = makeOwner([{ path: "out/a.md", seq: 999, index: 0 }], null);
	const result = selectCards(owner);
	assert.ok(result);
	assert.equal(result.files.length, 1);
});

// ── 主题适配（暗色/亮色）防回归 ────────────────────────────────────────────
// 卡片配色必须照抄官方 ui-deliverables 的做法：static neutral 是绝对值、不随主题变，
// 所以必须用 body[data-ds-dark-theme] 显式改引用；其余走 --dsw-alias-*（亮暗各一套）。

test("配色跟随官方：亮色用 neutral-50/100，暗色用 neutral-850/800 显式切换", () => {
	const { css } = mod;
	assert.match(css, /body\[data-ds-dark-theme\]\s*\.dshdc_root/, "必须有暗色作用域");
	assert.match(css, /--dshdc-fill:var\(--dsw-static-neutral-50\)/, "亮色底 = neutral-50");
	assert.match(css, /--dshdc-hover:var\(--dsw-static-neutral-100\)/, "亮色悬停 = neutral-100");
	assert.match(css, /--dshdc-fill:var\(--dsw-static-neutral-850\)/, "暗色底 = neutral-850");
	assert.match(css, /--dshdc-hover:var\(--dsw-static-neutral-800\)/, "暗色悬停 = neutral-800");
});

test("零硬编码颜色：所有颜色都走 --dsw-* token，因此亮暗色都会跟随", () => {
	const { css } = mod;
	// 去掉所有 var(--dsw-*) 引用后，不应再残留任何颜色字面量。
	// 注意：曾经写过 var(--dsw-alias-label-error,#d33) —— 该 token 并不存在，
	// 于是兜底 #d33 一直生效、且不跟随主题。正确 token 是 state-error-primary。
	const withoutTokens = css.replace(/var\(--dsw-[a-z0-9-]+\)/g, "VAR");
	const literals = withoutTokens.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g) ?? [];
	assert.deepEqual(literals, [], `发现硬编码颜色：${literals.join(", ")}——它们不会跟随暗色主题`);
});

test("用到的 --dsw-alias-* token 必须真实存在（防写错名字后静默兜底）", () => {
	const { css } = mod;
	// 从主题包里已核实的 alias token 清单（亮暗各有定义的那批）。
	const known = new Set([
		"--dsw-alias-border-l1",
		"--dsw-alias-border-l2",
		"--dsw-alias-interactive-bg-hover",
		"--dsw-alias-label-primary",
		"--dsw-alias-label-secondary",
		"--dsw-alias-link",
		"--dsw-alias-state-error-primary",
		"--dsw-alias-state-error-secondary",
		"--dsw-alias-state-success-primary",
		"--dsw-alias-state-success-secondary",
		"--dsw-alias-state-warn-label",
		"--dsw-alias-state-warn-secondary",
		"--dsw-alias-state-business-primary",
		"--dsw-alias-brand-primary",
	]);
	const used = [...new Set([...css.matchAll(/var\((--dsw-alias-[a-z0-9-]+)/g)].map((m) => m[1]))];
	assert.ok(used.length > 0, "应当用到 alias token");
	const unknown = used.filter((token) => !known.has(token));
	assert.deepEqual(unknown, [], `未核实的 token：${unknown.join(", ")}`);
});

test("卡片尺寸与圆角对齐官方 .file（60px 高 / 18px 圆角 / 40px 图标）", () => {
	const { css } = mod;
	assert.match(css, /\.dshdc_card\{[^}]*height:60px/);
	assert.match(css, /\.dshdc_card\{[^}]*border-radius:18px/);
	assert.match(css, /\.dshdc_badge\{[^}]*width:40px/);
	assert.match(css, /\.dshdc_badge\{[^}]*height:40px/);
	assert.match(css, /\.dshdc_badge\{[^}]*border-radius:10px/);
});

// ── 失效可见性（踩过的坑：按钮被静默禁用，点了完全没反应） ──────────────────

test("失败提示必须带 HTTP 状态码，否则无法定位", () => {
	const { describeFailure } = mod;
	for (const status of [400, 401, 403, 404, 409, 422, 500]) {
		assert.match(
			describeFailure(status),
			new RegExp(`HTTP ${status}`),
			`状态码 ${status} 必须出现在提示里`,
		);
	}
	assert.match(describeFailure(0), /没有发出/);
});

test("成功提示必须说明「窗口可能开在后台」（Windows 前台锁的实测结论）", () => {
	const { describeSuccess } = mod;
	assert.match(describeSuccess("reveal"), /资源管理器/);
	assert.match(describeSuccess("reveal"), /后台/, "必须告知窗口可能开在后台，否则用户以为没反应");
	assert.match(describeSuccess("reveal"), /Alt\+Tab/);
	assert.match(describeSuccess("open"), /默认程序/);
});

test("原生动作 URL 使用官方路由与四个查询参数", () => {
	const { nativeUrl } = mod;
	assert.equal(
		nativeUrl("sess-1", 71, 0, "reveal"),
		"/api/present.open?sessionId=sess-1&seq=71&index=0&action=reveal",
	);
	assert.equal(
		nativeUrl("sess-1", 71, 1, "open"),
		"/api/present.open?sessionId=sess-1&seq=71&index=1&action=open",
	);
});

test("不再依赖 /api/present.host 做前置探测（探测失败会静默禁用按钮）", () => {
	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	// 注释里会提到这个坑，所以只查**代码标识符**，不查字面字符串。
	assert.ok(!source.includes("PRESENT_HOST_PATH"), "不应再声明宿主桌面探测常量");
	assert.ok(!/fetch\(\s*["'`]\/api\/present\.host/.test(source), "不应再请求 /api/present.host");
	assert.ok(!/disabled:\s*!desktopReady/.test(source), "按钮不得由桌面探测结果决定是否禁用");
});

// ── 文件类型图标 ───────────────────────────────────────────────────────────

test("同族扩展名必须归到同一个图标（pptx→ppt、xlsx→sheet、docx→doc）", () => {
	const cases = {
		"报告.pdf": "pdf",
		"方案.ppt": "ppt",
		"方案.pptx": "ppt",
		"方案.ppsx": "ppt",
		"方案.odp": "ppt",
		"合同.doc": "doc",
		"合同.docx": "doc",
		"合同.rtf": "doc",
		"数据.xls": "sheet",
		"数据.xlsx": "sheet",
		"数据.csv": "sheet",
		"数据.tsv": "sheet",
		"说明.md": "md",
		"说明.markdown": "md",
		"页面.html": "html",
		"页面.htm": "html",
		"页面.xhtml": "html",
	};
	for (const [name, kind] of Object.entries(cases)) {
		assert.equal(fileKind(name), kind, `${name} 应为 ${kind}`);
	}
});

test("大小写不敏感，未收录的扩展名返回 null（回落成文字徽标）", () => {
	assert.equal(fileKind("REPORT.PDF"), "pdf");
	assert.equal(fileKind("Deck.PpTx"), "ppt");
	assert.equal(fileKind("DATA.CSV"), "sheet");
	assert.equal(fileKind("photo.JPG"), "image");
	// 这些是"操作系统认识、但不会出现在交付卡片里"的格式——刻意不收录
	assert.equal(fileKind("D:\\a\\b\\设计稿.FIG"), null);
	assert.equal(fileKind("setup.exe"), null);
	assert.equal(fileKind("font.woff2"), null);
	assert.equal(fileKind("noext"), null);
	assert.equal(fileKind("trailing."), null);
	assert.equal(fileKind(".gitignore"), null, "隐藏文件不应被当成扩展名");
});

test("图标配色必须走 alias（随主题变），不许用 static（亮暗同值）", () => {
	const { css } = mod;
	// 这条守卫来自一次真实缺陷：图标原本用 --dsw-static-*-400/500 上色，
	// 而静态色板在亮暗两套里**取值完全相同**——那些中浅色本来是给暗色底设计的，
	// 放到 #fafafa 亮底上，六个图标的对比度掉到 3:1 以下（最差 video 只有 1.83:1）。
	// 换成 alias 后由主题自动换档（如 state-error-primary 亮=red-600、暗=red-400）。
	const iconRules = [...css.matchAll(/[^{}]*\.dshdc_badge\[data-kind=[a-z]+\]\{color:var\((--dsw-[a-z0-9-]+)\)\}/g)];
	assert.ok(iconRules.length >= 10, `应当有十余条图标配色规则，实际 ${iconRules.length}`);
	const statics = iconRules.filter((m) => m[1].startsWith("--dsw-static-"));
	assert.deepEqual(
		statics.map((m) => m[1]),
		[],
		"图标配色不得使用静态色板——它在亮暗两套里同值，会导致某个主题下对比度不足",
	);
});

test("诊断上报只在失败路径上（成功路径不得写日志）", () => {
	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	// 这条守卫来自一次真实问题：早先每次**卡片挂载**都上报一行，
	// 而挂载是每次渲染都会发生的——日志无限增长，且绝大多数是没有价值的心跳。
	// 现在三处：每页一次的接手判定（boot）+ 两处失败（fail / throw）。
	const calls = [...source.matchAll(/probe\(\{([^}]*)\}/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
	assert.equal(calls.length, 3, `应为 boot + 两处失败，实际 ${calls.length}：${calls.join(" | ")}`);
	assert.match(calls[0], /stage: "boot"/);
	assert.match(calls[1], /stage: "fail"/);
	assert.match(calls[2], /stage: "throw"/);
	assert.match(calls[0], /source: source \|\| "presented"/, "boot 上报应携带 source 字段以便诊断 fallback 路径");
	for (const call of calls) {
		assert.ok(!/stage: "mount"/.test(call), "不得在挂载时上报（挂载是每次渲染都发生的）");
		assert.ok(!/stage: "click"/.test(call), "不得在点击时上报（点击本身不是失败）");
		assert.ok(!/stage: "result"/.test(call), "不得上报成功结果");
	}
	// boot 必须**每页只一次**，否则又变成无限增长
	assert.match(source, /if \(decisionReported\) return;\s*decisionReported = true;/, "boot 上报必须只执行一次");
	// 挂载时应只装样式
	assert.match(source, /useEffect\(\(\) => \{\s*ensureStyles\(\);\s*\}, \[\]\)/);
});

test("宿主必须给诊断日志封顶（否则保留每页一行仍会无限增长）", () => {
	const host = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
	assert.match(host, /function trimLog/, "必须有裁剪函数");
	assert.match(host, /LOG_MAX_BYTES/, "必须有大小上限常量");
	assert.match(host, /LOG_KEEP_LINES/, "必须保留最后若干行");
	// 每次追加都要顺手裁剪。别用跨调用的正则——appendFileSync 的模板串里含
	// `toISOString()`，括号会打断 `[^)]*` 这类写法（踩过）。
	const from = host.indexOf("function append");
	assert.ok(from > 0, "应能找到 append 函数");
	const appendFn = host.slice(from, from + 600);
	assert.match(appendFn, /appendFileSync/, "append 里要写文件");
	assert.match(appendFn, /trimLog\(\)/, "append 里每次写完都要触发裁剪");
});

test("装配成功后必须取消告警定时器（否则打印误导性的 WARN）", () => {
	const host = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
	const wireBlock = host.slice(host.indexOf("if (!wire())"));
	assert.match(wireBlock, /clearTimeout\(warn\)/, "wire 成功时必须 clearTimeout(warn)");
});

test("每个种类都有图标字形与配色规则", () => {
	const kinds = ["pdf", "doc", "sheet", "ppt", "html", "image", "video", "audio", "archive", "code"];
	for (const kind of kinds) {
		const icon = kindIcon(kind);
		assert.ok(icon, `${kind} 应有图标`);
		assert.equal(icon.props.viewBox, "0 0 24 24");
		assert.ok(Array.isArray(icon.props.children) && icon.props.children.length > 0, `${kind} 应有路径`);
		assert.match(css, new RegExp(`\\.dshdc_badge\\[data-kind=${kind}\\]\\{color:var\\(--dsw-`), `${kind} 应有配色规则`);
	}
	assert.equal(kindIcon("unknown"), null);
	assert.equal(kindIcon("md"), null, "md 走文字徽标，不应有字形");
});

test("MD 走文字徽标且配色不再是灰", () => {
	assert.ok(textKinds.has("md"), "md 应在 TEXT_KINDS 里");
	const badge = badgeFor("说明.md");
	assert.equal(badge.props["data-kind"], "md");
	assert.equal(badge.props.children, "MD", "徽标文字应为 MD");
	assert.match(css, /\.dshdc_badge\[data-kind=md\]\{color:var\(--dsw-alias-link\)\}/);
	assert.ok(
		!/data-kind=md\]\{color:var\(--dsw-alias-label-secondary\)\}/.test(css),
		"MD 不应再是灰色",
	);
});

test("AI 常产出的类型都各自有图标，不再落回文字徽标", () => {
	// 这些是实际交付里最常见的，必须各有图标
	const mustHaveIcon = {
		"报告.pdf": "pdf",
		"方案.docx": "doc",
		"笔记.txt": "doc",
		"数据.xlsx": "sheet",
		"导出.csv": "sheet",
		"演示.pptx": "ppt",
		"页面.html": "html",
		"配图.png": "image",
		"照片.jpg": "image",
		"截图.jpeg": "image",
		"矢量.svg": "image",
		"动画.gif": "image",
		"录屏.mp4": "video",
		"片段.mov": "video",
		"解说.mp3": "audio",
		"录音.wav": "audio",
		"打包.zip": "archive",
		"备份.7z": "archive",
		"数据.json": "code",
		"配置.yaml": "code",
		"脚本.py": "code",
		"源码.ts": "code",
		"页面.tsx": "code",
		"查询.sql": "code",
		"笔记.ipynb": "code",
	};
	for (const [name, kind] of Object.entries(mustHaveIcon)) {
		assert.equal(fileKind(name), kind, `${name} 应为 ${kind}`);
	}
});

test("`.ts` 归代码而不是视频（有歧义，按交付场景取 TypeScript）", () => {
	assert.equal(fileKind("utils.ts"), "code");
	assert.equal(fileKind("stream.mts"), "video", "无歧义的视频扩展名仍归视频");
});

test("未收录的扩展名回落成文字徽标（不给通用图标）", () => {
	const badge = badgeFor("archive.fig");
	assert.equal(badge.props["data-kind"], undefined, "未收录不应带 data-kind");
	assert.equal(badge.props.children, "FIG");
});

test("图标颜色只用主题自带的静态色板与 alias 语义色", () => {
	// 静态色板实测只存在这六族（值在亮暗两套里相同）
	const palette = new Set([
		"--dsw-static-amber",
		"--dsw-static-blue",
		"--dsw-static-deepseek",
		"--dsw-static-green",
		"--dsw-static-neutral",
		"--dsw-static-red",
	]);
	for (const token of css.matchAll(/var\((--dsw-static-[a-z]+)-/g)) {
		assert.ok(palette.has(token[1]), `${token[1]} 不在实测存在的静态色板里`);
	}
});

// ── v2.0 客户端兜底层（启发式 + produced fallback）────────────────────
// 解决非训练模型忘 present 的问题：presented 为空时，从 produced 启发式过滤出
// 看起来是最终交付的文件，render 它们。
//
// 测试矩阵 T1-T6（与 OpenViking 设计文档 `dsh-delivery-cards-v2-fallback.md` 对齐）

test("T1 - Flash 模型正常 present 路径：presented 优先，不走 fallback", () => {
	const owner = makeOwner(
		[{ path: "D:\\final.md", description: "最终方案", seq: 1, index: 0 }],
		100,
		// produced 同时存在（这不应该发生于正常流程，但保证 presented 优先）
		[{ path: "D:\\out\\a.md", description: "produced 候选", seq: 2, index: 0 }],
	);
	const result = selectCards(owner);
	assert.ok(result, "Flash 模型有 presented 必须 render");
	assert.equal(result.files.length, 1, "应只 render 1 个 presented 文件");
	assert.equal(result.files[0].path, "D:\\final.md", "render presented 而非 produced");
});

test("T2 - 非训练模型（Kimi/Claude/GPT）忘 present：presented 为空，启发式兜底", () => {
	const owner = makeOwner(
		[], // 忘 present
		100,
		[
			{ path: "D:\\project\\out\\v1.0.md", description: "方案 v1.0", seq: 1, index: 0 },
			{ path: "D:\\project\\out\\final.md", description: "最终", seq: 2, index: 0 },
			{ path: "D:\\project\\result.md", description: "结果", seq: 3, index: 0 },
			{ path: "D:\\project\\_apply_v1.py", description: "脚本（过程文件）", seq: 4, index: 0 },
			{ path: "D:\\project\\_inspect.py", description: "调试脚本", seq: 5, index: 0 },
		],
	);
	const result = selectCards(owner);
	assert.ok(result, "兜底应 render");
	assert.equal(result.files.length, 3, "3 启发命中（out / final / result）+ 2 脚本排除");
	const paths = result.files.map((f) => f.path).sort();
	assert.deepEqual(paths, [
		"D:\\project\\out\\final.md",
		"D:\\project\\out\\v1.0.md",
		"D:\\project\\result.md",
	]);
});

test("T3 - 纯过程文件无 present：兜底命中 0，弃权让位 better-sidebar", () => {
	const owner = makeOwner(
		[],
		100,
		[
			{ path: "D:\\tmp\\_apply_v1.py", seq: 1, index: 0 },
			{ path: "D:\\tmp\\_inspect.py", seq: 2, index: 0 },
			{ path: "D:\\debug\\test.py", seq: 3, index: 0 },
		],
	);
	const result = selectCards(owner);
	assert.equal(result, null, "纯过程文件必须弃权让位 better-sidebar");
});

test("T4 - 启发式排除：路径/格式/大小 三种信号都能拦住过程文件", () => {
	// 路径含 _inspect_/_apply_/_test_/_.tmp/ → 排除
	assert.equal(isLikelyDeliverable({ path: "D:\\a\\_apply_v1.py" }), false);
	assert.equal(isLikelyDeliverable({ path: "D:\\a\\_inspect.py" }), false);
	assert.equal(isLikelyDeliverable({ path: "D:\\a\\_test_foo.py" }), false);
	assert.equal(isLikelyDeliverable({ path: "D:\\a\\x.tmp" }), false);
	// 路径含 /tmp/ 或 /debug/ → 排除
	assert.equal(isLikelyDeliverable({ path: "D:\\tmp\\foo.md" }), false);
	assert.equal(isLikelyDeliverable({ path: "D:\\debug\\bar.md" }), false);
	// 命中包含规则 → 包含
	assert.equal(isLikelyDeliverable({ path: "D:\\out\\final.md" }), true);
	assert.equal(isLikelyDeliverable({ path: "D:\\FINAL.md" }), true);
	assert.equal(isLikelyDeliverable({ path: "D:\\终稿.md" }), true);
	assert.equal(isLikelyDeliverable({ path: "D:\\v1.0.md" }), true);
	// 命中用户文档扩展名 → 包含
	assert.equal(isLikelyDeliverable({ path: "D:\\a.md" }), true);
	assert.equal(isLikelyDeliverable({ path: "D:\\a.pdf" }), true);
	assert.equal(isLikelyDeliverable({ path: "D:\\a.docx" }), true);
	// 大小 > 5KB → 包含
	assert.equal(isLikelyDeliverable({ path: "D:\\random.dat", size: 10 * 1024 }), true);
	// 拿不准 → 排除（保守）
	assert.equal(isLikelyDeliverable({ path: "D:\\xyz.unknownext" }), false);
	assert.equal(isLikelyDeliverable({ path: "D:\\xyz" }), false);
});

test("T5 - mixed presented + produced：presented 优先（不混合）", () => {
	const owner = makeOwner(
		[{ path: "D:\\final.md", seq: 1, index: 0 }], // presented 只有 1 个
		100,
		// produced 含 5 个应该兜底的
		[
			{ path: "D:\\out\\v1.md", seq: 2, index: 0 },
			{ path: "D:\\out\\v2.md", seq: 3, index: 0 },
			{ path: "D:\\out\\v3.md", seq: 4, index: 0 },
			{ path: "D:\\out\\v4.md", seq: 5, index: 0 },
			{ path: "D:\\out\\v5.md", seq: 6, index: 0 },
		],
	);
	const result = selectCards(owner);
	assert.equal(result.files.length, 1, "presented 优先：只 render 1 个");
	assert.equal(result.files[0].path, "D:\\final.md", "不与 produced 混合");
});

test("T6 - 兜底去重：同文件不同写法只一张卡（修 dsh-auto-deliver 双卡 bug）", () => {
	// 三种写法应该规范化到同一路径——绝对 vs 相对 vs 大小写
	// 注：WSL 路径（/c/Users/...）不会自动等价于 Windows 路径（这是 OS 适配问题，
	// 不是插件的事；v2.0 只修"同 OS 内不同写法"的双卡）
	const owner = makeOwner(
		[],
		100,
		[
			{ path: "D:\\project\\out\\final.md", seq: 1, index: 0 },
			{ path: "D:\\project\\out\\FINAL.MD", seq: 2, index: 0 }, // 大小写
			{ path: "D:\\project\\out\\final.md/", seq: 3, index: 0 }, // 末尾斜杠
		],
	);
	const result = selectCards(owner);
	assert.ok(result);
	assert.equal(result.files.length, 1, "三种写法规范化后是同一文件，必须去重到 1");
	assert.equal(result.files[0].path, "D:\\project\\out\\final.md", "保留第一条原始路径");
});

test("T7 - normalizePath 统一规范（修 v1.0.2 时代就记录的路径字面量去重 bug）", () => {
	assert.equal(normalizePath("D:\\a\\b.md"), "d:/a/b.md");
	assert.equal(normalizePath("d:/a/b.md/"), "d:/a/b.md", "去末尾斜杠");
	assert.equal(normalizePath("D:\\A\\B.MD"), "d:/a/b.md", "全小写");
	assert.equal(normalizePath(""), "", "空字符串保护");
	assert.equal(normalizePath(null), "", "null 保护");
	assert.equal(normalizePath(undefined), "", "undefined 保护");
	assert.equal(normalizePath(42), "", "非字符串保护");
});

test("T8 - heuristicFallbackFor 复用 presentedFor 的 seq 过滤逻辑", () => {
	// seq >= owner.seq 的文件应被过滤（owner.seq 是收尾 assistant 消息的序号）
	const owner = {
		seq: 50,
		turn: {
			data: {
				get: (key) => {
					if (key === "deliverables") return {
						presented: [],
						produced: [
							{ path: "D:\\out\\early.md", seq: 10, index: 0 }, // 通过
							{ path: "D:\\out\\equal.md", seq: 50, index: 0 }, // 不通过（不是 <）
							{ path: "D:\\out\\late.md", seq: 100, index: 0 }, // 不通过
						],
					};
					return undefined;
				},
			},
		},
		openFile: () => {},
	};
	const files = heuristicFallbackFor(owner);
	assert.equal(files.length, 1, "只有 seq < 50 的通过");
	assert.equal(files[0].path, "D:\\out\\early.md");
});

test("T9 - heuristicFallbackFor 在 owner.seq 缺失时不筛（宁可不筛也不让整行消失）", () => {
	const owner = {
		seq: null, // 模拟缺失
		turn: {
			data: {
				get: (key) => {
					if (key === "deliverables") return {
						presented: [],
						produced: [
							{ path: "D:\\out\\a.md", seq: 999, index: 0 },
						],
					};
					return undefined;
				},
			},
		},
		openFile: () => {},
	};
	const files = heuristicFallbackFor(owner);
	assert.equal(files.length, 1, "owner.seq 缺失时不过滤");
});
