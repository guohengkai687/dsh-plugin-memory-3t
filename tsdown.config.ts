/**
 * 客户端 bundle 构建（v0.5 新增）：tsdown → client/client.js。
 *
 * 平面 CJS + __ModuleLoader__ 工厂包装（与 DSH 客户端插件的 module-table 约定一致）：
 * - externals：仅 react / react/jsx-runtime（loader module table 提供，绝不内联）。
 * - 其余（含 src/shared.ts、组件）全部内联；@deepseek-ai/dsh-client-* 只作类型引用，
 *   编译期擦除，不会进入产物。
 * - @deepseek-ai/dsh-settings / schemastery 属服务端依赖，绝不进入浏览器产物。
 */
import { defineConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-plugin-memory-3t'

export default defineConfig({
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'client',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: true,
  deps: {
    // 仅 react / react/jsx-runtime 走 loader module table（绝不内联）；其余全部内联。
    neverBundle: ['react', 'react/jsx-runtime'],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})