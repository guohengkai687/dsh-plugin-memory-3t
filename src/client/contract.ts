/**
 * 浏览器侧最小契约（本地声明，避免与宿主客户端包的跨版本类型耦合）。
 *
 * DSH 0.1.7 的客户端设置 API：
 * - 设置数值走 `ctx.configForms.get(条目 id)`（0.1.1 的 `ctx.settingsScope` 已整体移除）；
 * - 槽位与字典 API 未变（`ctx.slots.inject/register`、`ctx.locale.register/bind`）。
 *
 * 这些类型只作编译期约束，tsdown 打包时被擦除——bundle 运行时零依赖。
 */

import type { ComponentType } from 'react'

/** 一个 profile 条目（= 设置命名空间）的表单快照。 */
export interface ConfigFormSnapshot<T> {
  /** `loading`：首次应答前；`ready`：已有生效值；`unavailable`：本客户端未获服务或仅进程内保存。 */
  status: 'loading' | 'ready' | 'unavailable'
  /** 最近一次被接受的 schema 解析值（只含宿主声明的 volatile 字段）。 */
  value: T | undefined
  /** 生效值所覆盖的组成层（字段清空后回落到的值）。 */
  base: unknown
  /** 已存储的原始用户层（字段"是否存在"即是否被覆盖）。 */
  user: unknown
  /** 下一次写入的版本栅栏。 */
  revision: number | undefined
  /** 宿主文档是否接受写入。 */
  writable: boolean
  /** `host`：与宿主文档同步；`memory`：仅浏览器进程内。 */
  mode: 'host' | 'memory'
}

/**
 * 一个 profile 条目的表单读写面（与宿主 `ctx.settings` 同一份值）。
 * 宿主还提供 `unset` / `mutate`（路径式原子编辑），本插件只用 `set`。
 */
export interface ConfigForm<T> {
  getSnapshot(): ConfigFormSnapshot<T>
  subscribe(listener: () => void): () => void
  /**
   * 写一个字段：组级 volatile 字段（如 `vcs`）传整个组对象。
   * @returns 宿主是否接受；拒绝返回 false，传输失败则 reject。
   */
  set(field: string, value: unknown): Promise<boolean>
}

/** 设置域服务（`@deepseek-ai/dsh-client-ui-settings` 的 `configForms`，取子集）。 */
export interface ConfigFormsService {
  /** 取某个宿主条目 id 的共享表单（同一 id 多次调用返回同一实例）。 */
  get<T>(entryId: string): ConfigForm<T>
  /**
   * 宿主开始服务这些命名空间时注册贡献，全部消失时自动摘除。
   * @returns 结束监听的 disposer（交给 `ctx.effect` 持有）。
   */
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
}

/** 浏览器侧插件上下文的最小结构形状（运行时由 cordis 提供）。 */
export interface BrowserPluginContext {
  slots: {
    /** 等槽位声明就绪后执行注册回调；返回解除注册的 disposer。 */
    inject(name: string, register: () => () => void): () => void
    register(options: Record<string, unknown>, component: ComponentType<Record<string, never>>): () => void
  }
  locale: {
    register(ns: string, dict: Record<string, unknown>): unknown
    bind(ns: string): (key: string) => string
  }
  configForms: ConfigFormsService
  effect(fn: () => unknown, label?: string): unknown
}
