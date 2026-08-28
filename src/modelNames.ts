// 方块徽章用的纯格式化函数（Task 6，spec §5.3）：模型短名 + 上下文 token 的绝对值显示。
// 两个函数都不接受 SessionBlock 之外的语境，纯输入->输出，方便单测覆盖，也方便未来其它
// 地方（例如设置页若要展示同一份模型信息）复用。

// 前缀表：只认「claude-」可选前缀 + 家族名（opus/sonnet/haiku）+ 可选版本号（如
// 「5」「4-5」，短横线代表小数点）+ 可选的 8 位日期后缀（模型 id 里常见的构建日期，
// 徽章不需要它）。命中不了这张表的 id（未来新模型/自定义 id）原样返回，不猜、不留空白
// ——调用方仍然可以直接把返回值当文本渲染。
const FAMILY_LABELS: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
}

const MODEL_ID_RE = /^(?:claude-)?(opus|sonnet|haiku)(?:-(\d+(?:-\d+)?))?(?:-\d{8})?$/

/** 模型 id → 人读短名（如 'claude-opus-5' → 'Opus 5'）。认不出的 id 原样返回；
 * 缺失（null/undefined）返回 undefined，由调用方决定不渲染该徽章。 */
export function shortModelName(id: string | null | undefined): string | undefined {
  if (id == null) return undefined
  const m = MODEL_ID_RE.exec(id)
  if (!m) return id
  const label = FAMILY_LABELS[m[1]]
  const version = m[2]
  return version ? `${label} ${version.replace('-', '.')}` : label
}

/** 上下文 token 数 → 徽章文案的绝对值（如 106797 → '107k'）。**不显示百分比**——
 * 上下文窗口大小无法从会话记录里可靠还原，猜一个分母只会显示误导性的百分比，这是
 * 明确的产品决策，见 task 6 brief。千位以上四舍五入到 k；不足千位显示原值；缺失返回
 * undefined。 */
export function formatContextTokens(n: number | null | undefined): string | undefined {
  if (n == null) return undefined
  if (n < 1000) return String(n)
  return `${Math.round(n / 1000)}k`
}
