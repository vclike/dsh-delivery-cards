/**
 * dsh-delivery-cards — 宿主半边。
 *
 * 全部 UI 行为都在浏览器半边（lib/client.js）。本半边存在有两个理由：
 * ① 让 Loader 有一条启用的 entry——client-modules 只扫描**已启用**的 Loader 条目，
 *    再据其 package.json 的 `dsh.client` 声明把浏览器 bundle 组装进启动图；
 * ② 修掉上游 reveal 的一个缺陷（见下）。
 *
 * ── 上游缺陷与修法（2026-09-13 实测） ────────────────────────────────────
 * `@deepseek-ai/dsh-native-command` 的 revealNativePath：
 *
 *     await run("explorer.exe", ["/select,", target], signal)   // execFile(..., { windowsHide: true })
 *
 * `windowsHide` 会把子进程 STARTUPINFO 的显示状态设成隐藏，于是 **Explorer 新建的
 * 窗口被创建为不可见**（IsWindowVisible=False）——客户端拿到 204、以为成功，
 * 用户屏幕上什么都没有。A/B 实测（同一条命令，只改这一个布尔值）：
 *
 *     windowsHide=true  → IsWindowVisible=False
 *     windowsHide=false → IsWindowVisible=True
 *
 * `windowsHide` 本是给**控制台程序**避免闪黑框用的；用在 GUI 打开器上，
 * 副作用就是把窗口藏了。上游正解是去掉它。这里在 win32 上用**自己的 spawn**
 * 接管 reveal：同样的 `explorer.exe /select,`，但 `windowsHide: false`，
 * 于是窗口从一开始就是可见的。非 win32 平台一律交还原实现。
 *
 * ── 每一层都必须可观测 ──────────────────────────────────────────────────
 * 上一轮的教训：我拿"手动跑兜底脚本成功"当成了"点击路径成功"，属于循环论证。
 * 现在每次 reveal 都会往探针日志写一行，兜底脚本也自带日志文件——
 * **点击路径的每一层都有独立证据**，不再靠推断。
 *
 * ⚠️ 刻意**不声明 `inject` 数组**。
 * 踩过的坑：给一个提供方缺失的服务声明 inject，会让该 entry 永久 pending，
 * app-boot 的 assertEntriesActivated() 随即抛错，**整个 dsh web 起不来**
 * （dsh-ssh-tunnel × betterSidebar 那次）。本插件不提供任何服务，若它 pending
 * 一样会拖垮启动，所以这里用 `ctx.get()` 惰性取 + 轮询重试，绝不硬注入。
 */

import { execFile, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-delivery-cards'

/** 不硬注入任何服务：见文件头注释。 */
export const inject = []

/** 探针路由路径；浏览器半边用同一个字符串。 */
const PROBE_PATH = '/api/dsh-delivery-cards.probe'

/** 日志位置：放在 DSH_HOME 下，便于直接读。 */
const LOG_PATH = join(process.env.DSH_HOME ?? 'D:\\dsh\\home', 'cache', 'dsh-delivery-cards-probe.log')

/** 安全网脚本：与本文件同目录。 */
const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'bring-to-front.ps1')

/** 日志上限：超过就裁到只剩最后若干行。有它兜底，才敢保留"每页一行"这类诊断。 */
const LOG_MAX_BYTES = 128 * 1024
const LOG_KEEP_LINES = 400

/**
 * 日志超过上限时裁剪，只留最后若干行。
 * 任何失败都吞掉——诊断代码绝不能影响主流程。
 */
function trimLog() {
	try {
		if (statSync(LOG_PATH).size <= LOG_MAX_BYTES) return
		const kept = readFileSync(LOG_PATH, 'utf8').split('\n').slice(-LOG_KEEP_LINES).join('\n')
		writeFileSync(LOG_PATH, `... (trimmed to last ${LOG_KEEP_LINES} lines)\n${kept}`)
	} catch {
		// 裁不了就算了
	}
}

/**
 * 追加一行日志。任何失败都吞掉——诊断/兜底代码绝不能影响主流程。
 * @param line 单行内容。
 */
function append(line) {
	try {
		mkdirSync(dirname(LOG_PATH), { recursive: true })
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
		trimLog()
	} catch {
		// 日志写不了就算了，不能因此抛错
	}
}

/**
 * 用**可见**的方式在资源管理器中定位一个文件（win32）。
 *
 * 与上游唯一的不同就是 `windowsHide: false`——这正是窗口可见与否的分水岭。
 * @param path 绝对路径。
 * @param signal 调用方生命周期。
 * @returns 命令被接受后 resolve。
 */
function revealVisible(path, signal) {
	return new Promise((resolve, reject) => {
		execFile('explorer.exe', ['/select,', path], { windowsHide: false, signal }, (error) => {
			// Explorer 返回退出码 1 表示"已委派给现有桌面进程"，不是失败
			// （上游 revealNativePath 对这一点有同样的注释与处理）。
			if (error !== null && error.code !== 1) reject(error)
			else resolve()
		})
	})
}

/**
 * 是否在 spawn 之后再跑一次 `lib/bring-to-front.ps1`，把窗口提到前台。
 *
 * **默认打开。**
 *
 * 打开的理由（用户真实场景实测）：宿主 spawn 出来的资源管理器窗口是**可见**的，
 * 但它**从不抢前台**——表现为"窗口开在浏览器背后"，用户点完以为没反应。
 * 浏览器窗口大还是小都一样。这不是最小化、也不是隐藏，就是纯粹的前台问题。
 *
 * helper 里的 **ALT 键注入**是实测五种手法里唯一能突破 Windows 前台锁的
 * （`SetForegroundWindow` 不加它恒返回 `False`）：
 *
 *     ShowWindow(SW_RESTORE)                   → 仍被拒
 *     SetWindowPos(TOPMOST → NOTOPMOST)        → 被拒
 *     AttachThreadInput + SetForegroundWindow  → 返回 False
 *     SwitchToThisWindow                       → 被拒
 *     ALT 注入 + SetForegroundWindow           → True ✅
 *
 * 代价：每次点击多起一个 PowerShell 进程，窗口出现后约 0.35s 有一次"跳到最前"。
 * 这个 0.35s 已经把 COM 枚举从 2200ms 优化到 164ms（廉价属性先筛，见 helper）。
 *
 * 什么时候可以关掉：如果你的浏览器窗口很小、桌面大部分可见，窗口"开在背后"也看得见，
 * 那就改成 `false` 省掉那 0.35s。
 *
 * ⚠️ 别再把"某次演示里两者看不出差别"当成关掉它的理由——演示窗口能被看见，
 * 恰恰是因为当时桌面可见；真实使用时窗口是在浏览器背后的。
 */
const BRING_TO_FRONT = true

/**
 * 把窗口提到前台（仅在 BRING_TO_FRONT 为 true 时调用；fire-and-forget，绝不 await）。
 * 它自己的执行轨迹写在 `%DSH_HOME%\cache\dsh-delivery-cards-bring.log`。
 *
 * ⚠️ **绝不能加 `detached: true`**。实测（2026-09-13）从 Node spawn powershell.exe：
 *     detached + stdio:ignore      → 进程被创建、退出码 0，但脚本**一行都没执行**
 *     stdio:ignore（无 detached）  → 正常执行 ✅
 * 带 detached 时子进程拿不到控制台句柄，PowerShell 初始化即静默退出。
 * @param target 被定位文件的绝对路径。
 */
function bringToFront(target) {
	try {
		const child = spawn(
			'powershell.exe',
			[
				'-NoProfile',
				'-NonInteractive',
				'-ExecutionPolicy',
				'Bypass',
				'-File',
				HELPER,
				'-Target',
				target,
				'-TimeoutMs',
				'6000',
			],
			{ stdio: 'ignore', windowsHide: true },
		)
		child.on('error', (error) => append(`helper spawn error: ${String(error)}`))
		child.unref()
		append(`helper spawned pid=${child.pid ?? '?'}`)
	} catch (error) {
		append(`helper spawn threw: ${String(error)}`)
	}
}

/**
 * 装配宿主半边：登记探针路由，并接管 win32 的 reveal。
 * @param ctx 宿主插件上下文。
 */
export function apply(ctx) {
	append(`apply: host half activated (pid ${process.pid})`)

	let probeReady = false
	let revealWrapped = false

	/** 尝试登记探针路由；返回是否已登记。 */
	const tryRegisterProbe = () => {
		if (probeReady) return true
		const connection = ctx.get('connection')
		if (connection?.fetch?.register === undefined) return false
		connection.fetch.register({
			path: PROBE_PATH,
			methods: ['POST'],
			requestBody: 'buffered',
			fetch: async (request) => {
				let body = ''
				try {
					body = await request.text()
				} catch {
					body = '(body unreadable)'
				}
				append(`probe ${body.replace(/\s+/g, ' ').slice(0, 900)}`)
				return new Response(null, {
					status: 204,
					headers: { 'cache-control': 'no-store' },
				})
			},
		})
		probeReady = true
		append('probe route registered')
		return true
	}

	/**
	 * 包装 `sessionController.revealPath`：win32 上改走可见的 spawn，其它平台原样交还。
	 */
	const tryWrapReveal = () => {
		if (revealWrapped) return true
		const controller = ctx.get('sessionController')
		if (controller === undefined || typeof controller.revealPath !== 'function') return false
		if (controller.revealPath.__dshDeliveryCardsWrapped === true) {
			revealWrapped = true
			return true
		}
		const original = controller.revealPath.bind(controller)
		const wrapped = async (path, signal) => {
			if (process.platform !== 'win32' || typeof path !== 'string' || path.length === 0) {
				return original(path, signal)
			}
			append(`reveal(visible) start ${path}`)
			await revealVisible(path, signal)
			append(`reveal(visible) done ${path}`)
			if (BRING_TO_FRONT) bringToFront(path)
		}
		Object.defineProperty(wrapped, '__dshDeliveryCardsWrapped', { value: true })
		controller.revealPath = wrapped
		revealWrapped = true
		append('revealPath wrapped: win32 reveal now spawns explorer with windowsHide=false')
		return true
	}

	/** 两件事都待服务就绪，用同一个轮询推进。任何异常都必须吞掉。 */
	const wire = () => {
		let probe = false
		let reveal = false
		try {
			probe = tryRegisterProbe()
		} catch (error) {
			append(`probe wiring failed: ${String(error)}`)
			probe = true
		}
		try {
			reveal = tryWrapReveal()
		} catch (error) {
			append(`reveal wiring failed: ${String(error)}`)
			reveal = true
		}
		return probe && reveal
	}

	if (!wire()) {
		append('services not ready at apply; polling every 500ms')
		// 警告定时器必须在装配成功时一并取消，否则它会在 25 秒后照常触发、
		// 打印 probe=true reveal=true —— 一条纯误导的日志（踩过）。
		const warn = setTimeout(() => {
			append(`WARN wiring incomplete: probe=${probeReady} reveal=${revealWrapped}`)
		}, 25000)
		warn.unref?.()
		const timer = setInterval(() => {
			if (!wire()) return
			clearInterval(timer)
			clearTimeout(warn)
		}, 500)
		ctx.effect(() => () => clearInterval(timer))
	}
}
