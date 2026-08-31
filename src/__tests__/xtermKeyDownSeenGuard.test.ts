// 钉住一条私有 API 假设：src/components/TerminalView.tsx 里那段 macOS 中文输入法
// 绕行（"[ime] beforeinput 绕行"，见该文件注释与 .superpowers/sdd/ime-fix-report.md）
// 直接把 (term as unknown as { _core?: { _keyDownSeen?: boolean } })._core._keyDownSeen
// 强行置回 false。这是 @xterm/xterm 完全没有公开、随时可能改名/删除的私有字段——
// 一旦升级后改了名字，TerminalView.tsx 里读到的就是 undefined，绕行代码会按设计里的
// 防御性检测悄悄退化成"什么都不做"（console.warn 一次），中文输入法首字符丢失的问题
// 会不声不响地原样复发，793 个测试和构建都还是绿的。
//
// 这条测试不去实例化真实的 Terminal 来验证（那需要真实的浏览器合成时序，jsdom 复现
// 不了，参见 TerminalView.imeBeforeInputGuard.test.tsx 顶部注释里对测试边界的说明）。
// 这里只做一件更诚实、更稳的事：直接读 @xterm/xterm 实际发布的构建产物源码文本，
// 断言 `_keyDownSeen` 这个标识符字面量仍然存在。它在，不代表绕行行为一定正确
// （字段语义也可能变了，这条测试测不出来）；但它一旦消失，几乎可以肯定绕行已经失效，
// 这是能用最低成本抓住的信号。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const xtermSourcePath = path.resolve(repoRoot, 'node_modules/@xterm/xterm/lib/xterm.js')

describe('xterm 私有 API 假设钉子 —— _keyDownSeen', () => {
  it('_keyDownSeen 标识符仍存在于 @xterm/xterm 的构建产物里', () => {
    const source = fs.readFileSync(xtermSourcePath, 'utf-8')
    // 防止扫描对象意外塌缩成空文件/错误路径——那样下面的 includes 检查会永远读不出
    // 有意义的信号，这条闸门就形同虚设了（同样的自证写法见 tauriAcl.test.ts）。
    expect(source.length).toBeGreaterThan(10000)

    if (!source.includes('_keyDownSeen')) {
      throw new Error(
        '这不是测试本身坏了，是 @xterm/xterm 升级后内部结构变了：_keyDownSeen 这个私有字段' +
          '被改名或移除了。\n\n' +
          'src/components/TerminalView.tsx 里那段针对 macOS 中文输入法首个标点丢字问题的' +
          'beforeinput 绕行（搜 "_keyDownSeen" 或 "[ime] beforeinput 绕行"）依赖 ' +
          'term._core._keyDownSeen 这个私有字段，现在需要重新适配新版本的内部结构——否则' +
          '绕行会（按设计里的防御性检测）静默退化成什么都不做，中文输入法首字符丢失的问题' +
          '会不声不响地原样复发。详见 .superpowers/sdd/ime-fix-report.md。',
      )
    }
  })
})
