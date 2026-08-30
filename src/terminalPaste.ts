// 拖放文件到终端窗格时，要把落点文本当作一次「粘贴」投递给对应 xterm 实例
// （term.paste()），而不是当"打字"逐字符写入 PTY——真实终端把拖入文件也当作一次
// 粘贴，Claude Code 的图片附件识别正挂在粘贴事件上（括号粘贴 ESC[200~…ESC[201~），
// 逐字符写入永远不会触发它。App.tsx 的拖放落点不持有任何 Terminal 实例（那是
// TerminalView.tsx 里的局部变量），所以需要这样一个小注册表：TerminalView 在自己的
// effect 里把 `(text) => term.paste(text)` 注册进来，App.tsx 只按 ptyId 查表调用，
// 两边不必互相引用对方。写法照抄 ptyBuffer.ts 的 attachPty——模块级 Map + 返回一个
// 注销函数。
const pastes = new Map<string, (text: string) => void>()

/** 注册某个 PTY 对应终端的粘贴入口，返回注销函数。 */
export function registerPaste(ptyId: string, paste: (text: string) => void): () => void {
  pastes.set(ptyId, paste)
  return () => { pastes.delete(ptyId) }
}

/** 把文本作为一次「粘贴」投递给该终端。终端未注册时返回 false，调用方据此决定退路。 */
export function pasteTo(ptyId: string, text: string): boolean {
  const paste = pastes.get(ptyId)
  if (!paste) return false
  paste(text)
  return true
}
