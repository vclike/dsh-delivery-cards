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

const { presentedFor, selectCards, badgeText, fileKind, kindIcon, textKinds, badgeFor, css } = mod;

/** 造一个 owner：presented 列表挂在 turn.data 的 deliverables 键上。 */
function makeOwner(presented, seq = 100) {
	return {
		seq,
		turn: { data: { get: (key) => (key === "deliverables" ? { produced: [], presented } : undefined) } },
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
