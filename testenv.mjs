/**
 * 测试用的隔离环境。
 *
 * ## 为什么必须有它
 *
 * 这些脚本直接 `import('./index.js')`——那是**生产模块**，它的 `dshHome()`
 * 会解析到真实的 `~/.dsh`。而其中两个函数会**写盘**：
 *
 *   - `clearSlowModels()` 立即把空的 `profiles` / `slow` 写进
 *     `~/.dsh/dsh-baipiao-stone/speed-memory.json`；
 *   - `flushSpeedMemoryNow()` 同样落盘。
 *
 * 于是按 README 跑一次 `node speedcheck.mjs`，就会把用户真实积累的速度画像
 * 与慢模型记忆**整份清空**。实测复现过：预置一份带数据的 speed-memory.json，
 * 跑完 speedcheck 后变成 `{"profiles":{},"slow":{}}`。
 *
 * 修法是让每个脚本在 import 生产模块**之前**把 `DSH_HOME` 指向一个临时目录。
 * ESM 的 import 是静态提升的，所以不能写成「先设 env 再 import」——必须用
 * 动态 `import()`。本模块把这件事封装成 `isolate()`：
 *
 * ```js
 * import { isolate } from './testenv.mjs'
 * const m = await isolate()      // 返回 index.js 的模块命名空间
 * ```
 *
 * 临时目录在进程退出时删除（`process.on('exit')`）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 把 `DSH_HOME` 指向一个全新的临时目录，然后动态 import 生产模块。
 *
 * @param {string} [moduleUrl] - 要 import 的模块，默认同目录的 index.js
 * @returns {Promise<object>} 模块命名空间
 */
export async function isolate(moduleUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baipiao-test-'))
  process.env.DSH_HOME = root
  /**
   * 退出时清理。用 `exit` 而不是 `beforeExit`：脚本结尾是 `process.exit(...)`，
   * `beforeExit` 不会触发。
   */
  process.once('exit', () => {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 清理失败不影响测试结论 */ }
  })
  const target = moduleUrl ?? new URL('./index.js', import.meta.url).href
  return import(target)
}

/** 当前隔离根目录（调试用）。 */
export function isolatedRoot() {
  return process.env.DSH_HOME ?? ''
}
