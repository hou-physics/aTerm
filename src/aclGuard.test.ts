import { describe, expect, it } from 'vitest'
import {
  type AclManifests,
  checkAclCoverage,
  computeEffectivePermissions,
  extractCoreAllowCommands,
  formatViolation,
  findIdentifierOccurrences,
  kebabToCamel,
} from './aclGuard'

// 一份最小化、自造的 manifest fixture——不依赖真实的 acl-manifests.json 长什么样，
// 只搭出算法需要验证的三层结构：'core' 自己的 default 打包子模块 default，
// 子模块自己的 default 打包裸 allow-x，以及子模块的完整 permissions 表（含 deny-x，
// 用来验证 deny 被正确忽略）。
const manifests: AclManifests = {
  core: {
    permissions: {},
    default_permission: { identifier: 'default', permissions: ['core:window:default'] },
  },
  'core:window': {
    permissions: {
      'allow-set-size': { identifier: 'allow-set-size', commands: { allow: ['set_size'], deny: [] } },
      'allow-outer-size': { identifier: 'allow-outer-size', commands: { allow: ['outer_size'], deny: [] } },
      'deny-set-size': { identifier: 'deny-set-size', commands: { allow: [], deny: ['set_size'] } },
    },
    default_permission: { identifier: 'default', permissions: ['allow-outer-size'] },
  },
  'core:widget': {
    permissions: {
      'allow-set-color': { identifier: 'allow-set-color', commands: { allow: ['set_color'], deny: [] } },
    },
    default_permission: { identifier: 'default', permissions: [] },
  },
}

describe('kebabToCamel', () => {
  it('转换多段 kebab-case', () => {
    expect(kebabToCamel('set-size')).toBe('setSize')
    expect(kebabToCamel('current-monitor')).toBe('currentMonitor')
  })
  it('无连字符的名字原样返回', () => {
    expect(kebabToCamel('title')).toBe('title')
  })
})

describe('extractCoreAllowCommands', () => {
  it('只取 core:<mod> 下的 allow-*，忽略 core 本身与 deny-*', () => {
    const commands = extractCoreAllowCommands(manifests)
    const identifiers = commands.map((c) => c.identifier).sort()
    expect(identifiers).toEqual([
      'core:widget:allow-set-color',
      'core:window:allow-outer-size',
      'core:window:allow-set-size',
    ])
    const setSize = commands.find((c) => c.identifier === 'core:window:allow-set-size')
    expect(setSize?.camelName).toBe('setSize')
  })
})

describe('expandPermission / computeEffectivePermissions', () => {
  it('叶子 identifier 原样返回', () => {
    expect(computeEffectivePermissions(manifests, ['core:window:allow-set-size'])).toEqual(
      new Set(['core:window:allow-set-size']),
    )
  })
  it('<mod>:default 展开成该模块 default_permission.permissions 里的裸 allow-x，补上模块前缀', () => {
    const effective = computeEffectivePermissions(manifests, ['core:window:default'])
    expect(effective).toEqual(new Set(['core:window:allow-outer-size']))
  })
  it('core:default 递归展开一层：先到 core:window:default，再到裸 allow-x', () => {
    const effective = computeEffectivePermissions(manifests, ['core:default'])
    expect(effective).toEqual(new Set(['core:window:allow-outer-size']))
  })
})

describe('findIdentifierOccurrences', () => {
  it('按整词匹配，不匹配作为更长标识符一部分出现的子串', () => {
    const files = { 'a.ts': 'win.setSize(1, 2)\nconst windowSetSize = 1\nconst setSizeLimit = 2' }
    const occ = findIdentifierOccurrences('setSize', files)
    expect(occ).toHaveLength(1)
    expect(occ[0]).toEqual({ file: 'a.ts', line: 1, text: 'win.setSize(1, 2)' })
  })
  it('静态 import 与动态 import 两种写法都能命中，因为两者都会留下标识符本身', () => {
    const files = {
      static_: "import { setSize } from '@tauri-apps/api/window'",
      dynamic: "const { setSize } = await import('@tauri-apps/api/window')",
    }
    expect(findIdentifierOccurrences('setSize', files)).toHaveLength(2)
  })
})

describe('checkAclCoverage', () => {
  it('声明了权限 + 源码用了 → 通过（无违规）', () => {
    const violations = checkAclCoverage({
      manifests,
      declaredPermissions: ['core:window:allow-set-size'],
      productionFiles: { 'a.ts': 'win.setSize(1, 2)' },
    })
    expect(violations).toEqual([])
  })

  it('源码用了 + 没声明 → 报错，且错误信息里含正确的 identifier', () => {
    const violations = checkAclCoverage({
      manifests,
      declaredPermissions: [],
      productionFiles: { 'a.ts': 'win.setSize(1, 2)' },
    })
    expect(violations).toHaveLength(1)
    expect(violations[0].identifier).toBe('core:window:allow-set-size')
    const message = formatViolation(violations[0])
    expect(message).toContain('core:window:allow-set-size')
    expect(message).toContain('src-tauri/capabilities/default.json')
    expect(message).toContain('a.ts:1')
  })

  it('用了但未声明、且被 default 覆盖 → 通过', () => {
    const violations = checkAclCoverage({
      manifests,
      declaredPermissions: ['core:default'],
      productionFiles: { 'a.ts': 'win.outerSize()' },
    })
    expect(violations).toEqual([])
  })

  it('豁免表里的条目被跳过，即使用了也没声明', () => {
    const violations = checkAclCoverage({
      manifests,
      declaredPermissions: [],
      productionFiles: { 'a.ts': 'win.setSize(1, 2)' },
      exemptions: { 'core:window:allow-set-size': '测试用豁免理由' },
    })
    expect(violations).toEqual([])
  })

  it('没用到的命令不报违规，即使没声明', () => {
    const violations = checkAclCoverage({
      manifests,
      declaredPermissions: [],
      productionFiles: { 'a.ts': 'const x = 1' },
    })
    expect(violations).toEqual([])
  })
})
