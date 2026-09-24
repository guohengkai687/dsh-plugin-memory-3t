/**
 * 服务端与客户端 bundle 共享的纯常量（零依赖，可被浏览器 bundle 内联）。
 */

/** 客户端 i18n 字典命名空间（本插件自有，与宿主设置命名空间无关）。 */
export const DEV_MEMORY_SETTINGS_NS = 'dev-memory'

/**
 * DSH 设置表单的命名空间 = profile 条目 id（cordis.patch.yml 的 `id:`）。
 * 服务端 `Config`（volatile 字段）与客户端 `ctx.configForms.get(...)` 都用它。
 */
export const DEV_MEMORY_ENTRY_ID = 'dsh-plugin-memory-3t'

/**
 * 插件版本（必须与 package.json 的 `version` 一致，由 `test/version.test.mjs` 断言）。
 *
 * 用途：`apply` 启动时打一行自报日志。DSH 的 loader 按 URL 缓存 ESM 模块，
 * **重装插件但不重启 dsh 进程时，运行中的仍是旧模块**（新文件在磁盘上，进程里是旧的）——
 * 有这行日志才能一眼看出当前跑的到底是哪份代码。
 */
export const PLUGIN_VERSION = '0.7.4'