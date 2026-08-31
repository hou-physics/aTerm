// 这条闸门要防的事故：曾经实现"展开对话面板时窗口向右变宽"，逻辑、纯函数、DPR
// 换算全对，773 个测试全绿、构建也干净，但功能在打包版里一次都没工作过——根因是
// src-tauri/capabilities/default.json 当时只有 core:default，而 core:window 用到的
// win.setSize()/win.setPosition() 恰好不在 core:window:default 的 28 条默认权限里，
// 调用被 ACL 拒绝，串行化那条链末尾为了不让 jsdom 测试被未处理 rejection 污染而加的
// `.catch(() => {})` 又把拒绝静默吞掉了。jsdom 里没有真实的 Tauri 权限系统，这一整类
// 缺陷现有的测试结构完全抓不到。
//
// 这里不重新造一遍扫描算法——纯逻辑在 src/aclGuard.ts（连同它自己的单测
// src/aclGuard.test.ts）。这个文件只负责三件事：读真实的
// src-tauri/gen/schemas/acl-manifests.json、src-tauri/capabilities/*.json 与生产
// 代码，喂给那份纯逻辑，然后用 vitest 断言结果——本质是一条"仓库自洽性"断言，和其它
// 测试同类，`npx vitest run` 就能跑到，失败信息直接可读。
//
// 范围只覆盖 core:*（Tauri 内置命令）：自定义命令（invoke('list_projects') 这类，走
// generate_handler! 注册）不经过这套 ACL，只要有 core:default 就能调用，已实证；
// dialog:*/opener:* 等插件命令本次也没有纳入——先把出过事的 core:* 覆盖住。范围边界
// 与已知盲区的完整说明见 .superpowers/sdd/tauri-acl-guard-report.md。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AclManifests, checkAclCoverage, findIdentifierOccurrences, formatViolation } from '../aclGuard'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const srcRoot = path.resolve(repoRoot, 'src')
const manifestPath = path.resolve(repoRoot, 'src-tauri/gen/schemas/acl-manifests.json')
const capabilitiesDir = path.resolve(repoRoot, 'src-tauri/capabilities')

function loadManifests(): AclManifests {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as AclManifests
}

function loadDeclaredPermissions(): string[] {
  const files = fs.readdirSync(capabilitiesDir).filter((f) => f.endsWith('.json'))
  const out: string[] = []
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(capabilitiesDir, f), 'utf-8')) as { permissions?: string[] }
    out.push(...(data.permissions ?? []))
  }
  return out
}

/** 生产代码范围：src/**\/*.ts(x)，排除 src/__tests__/ 整个目录，以及任意位置的
 *  *.test.ts(x)（含 src/ 根目录下紧挨源文件的 paneDrop.test.ts / paneLayout.test.ts /
 *  panelWindow.test.ts 这类）。src/__tests__/ 下大量 vi.mock('@tauri-apps/api/...')
 *  会让这些命令名以字符串形式出现，混进来会产生一堆和真实调用无关的误报。 */
function collectProductionFiles(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      collectProductionFiles(full, out)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
    out[path.relative(repoRoot, full)] = fs.readFileSync(full, 'utf-8')
  }
  return out
}

// 豁免表：每一条都是先跑出真实误报、逐条读代码核对过之后才加的，理由见报告
// tauri-acl-guard-report.md 的第 1 节（含"收紧前 → 收紧后"的对比表）。
//
// v2：匹配从"标识符整词出现"收紧成"标识符 + 左括号"（看起来像一次调用）之后，
// 原来 20 个标识符（23 条 identifier 检查项）的豁免表缩到了下面这 9 条——
// `close`/`new`/`emit`/`insert`/`items`/`name`/`size`/`text`/`theme`/`title`/
// `version` 不再需要豁免，因为它们原来的命中全是对象字面量的键、JSX/HTML 属性、
// 普通变量名，收紧之后自然不再匹配（不需要靠豁免表人工排除）。
//
// 剩下这 9 条豁免的代价、也是这道闸门现在的已知盲区：豁免按"标识符 + 调用形态"生效，
// 不看调用接收者——如果将来真的有人在某个 Tauri 句柄上调用同名方法（比如真的需要
// `Menu.get(...)`），这张表会把它也一起放过。缩小这个盲区需要解析调用表达式的接收者
// 类型而不是搜文本，那需要接入 TS 的类型检查器，成本远超这道闸门的定位（vitest 里跑的
// 快速仓库自洽性检查）——见 aclGuard.ts 顶部与 findIdentifierOccurrences 的注释。
const EXEMPTIONS: Record<string, string> = {
  'core:path:allow-basename':
    'src/time.ts 自己的 basename() 字符串工具函数（从相对路径 ./time 导入），与 @tauri-apps/api/path 无关。',
  'core:window:allow-create':
    "命中的是 zustand 的 create<State>(...)（import { create } from 'zustand'），与窗口创建无关；" +
    '此前用整词匹配漏掉了这条泛型写法的调用形态，收紧后反而重新命中——保留豁免。',
  'core:menu:allow-get': '命中全是 Map.get(...)/zustand get() 状态访问器（含 store 内部到处调用的 get()），与 Menu.get() 无关。',
  'core:path:allow-join': 'Array.prototype.join(...)/字符串 join(...) 的调用，与 @tauri-apps/api/path 的 join 无关。',
  'core:menu:allow-remove': '命中的是 DOM classList.remove(...)，不是菜单命令。',
  'core:path:allow-resolve': '命中的是 Promise.resolve()，与 @tauri-apps/api/path 的 resolve 无关。',
  'core:image:allow-rgba': "命中的是模板字符串里拼 CSS 颜色用的字面量 'rgba(...)'，不是对 Image.rgba() 的调用。",
  'core:tray:allow-set-menu': 'React 的 setMenu(...) 状态 setter（useState 生成的），不是托盘命令。',
  'core:window:allow-show': '命中的是 store/hint.ts 自己的提示气泡 show(...) 方法，不是窗口的 show()。',
}

describe('Tauri ACL 覆盖闸门', () => {
  it('生产代码里用到的 core:* 命令全部在 capabilities 的有效权限集合内', () => {
    const manifests = loadManifests()
    const declared = loadDeclaredPermissions()
    const productionFiles = collectProductionFiles(srcRoot)

    // 防止扫描范围意外塌缩成空集——那样这条闸门会永远绿，形同虚设。
    expect(Object.keys(productionFiles).length).toBeGreaterThan(30)

    const violations = checkAclCoverage({
      manifests,
      declaredPermissions: declared,
      productionFiles,
      exemptions: EXEMPTIONS,
    })
    if (violations.length > 0) {
      throw new Error(
        `发现 ${violations.length} 处 core:* 命令用了但权限没声明：\n\n` +
          violations.map(formatViolation).join('\n\n'),
      )
    }
  })

  it('健全性检查：已知真实存在的 Tauri 调用确实被扫描器发现（排除"扫描范围出了问题导致假阴性"）', () => {
    const productionFiles = collectProductionFiles(srcRoot)
    // 对应 src/store/layout.ts 里 runPanelResize() 那条链，以及历史上真正出过事的
    // 那两个标识符（setSize/setPosition）。
    for (const camel of ['setSize', 'setPosition', 'outerPosition', 'outerSize', 'currentMonitor']) {
      expect(findIdentifierOccurrences(camel, productionFiles).length).toBeGreaterThan(0)
    }
  })
})
