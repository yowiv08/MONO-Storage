import { useId, useState } from 'react'
import { AlertCircle, Check, Copy, Download, LoaderCircle, Plug, ShieldCheck } from 'lucide-react'

export function McpGuide({ notify }: { notify: (message: string) => void }) {
  const titleId = useId()
  const endpoint = `${location.origin}/mcp`
  const configuration = JSON.stringify({ mcpServers: { mono: { url: endpoint, headers: { Authorization: 'Bearer <你的 API Token>' } } } }, null, 2)
  const [copied, setCopied] = useState('')
  const [guideBusy, setGuideBusy] = useState(false)
  const [guideText, setGuideText] = useState('')
  const [error, setError] = useState('')

  async function copy(text: string, label: string, key: string) {
    setError('')
    try { await navigator.clipboard.writeText(text); setCopied(key); notify(`${label}已复制`) }
    catch { setError('浏览器暂时无法复制，请选中下面的文本手动复制。') }
  }

  async function copyGuide() {
    if (guideBusy) return
    setGuideBusy(true); setError('')
    try {
      let text = guideText
      if (!text) {
        const response = await fetch('/api/mcp/guide', { credentials: 'same-origin', headers: { Accept: 'text/markdown' } })
        if (!response.ok) throw new Error(`暂时无法读取 AI 调用说明（${response.status}），请稍后重试。`)
        if (!(response.headers.get('Content-Type') || '').includes('text/markdown')) throw new Error('AI 调用说明暂时不可用，请稍后重试。')
        text = await response.text()
        setGuideText(text)
      }
      await copy(text, 'AI 调用说明', 'guide')
    } catch (error) { setError(error instanceof Error ? error.message : '暂时无法读取 AI 调用说明，请稍后重试。') }
    finally { setGuideBusy(false) }
  }

  return <section className="mcp-card" aria-labelledby={titleId}>
    <div className="mcp-heading"><span className="mcp-icon"><Plug size={23} strokeWidth={1.5} /></span><div><span className="mcp-eyebrow">MCP · STREAMABLE HTTP</span><h2 id={titleId}>让 AI 连接你的文件</h2><p>通过 MCP 调用存储 API，使用独立的 API Token 控制 AI 能访问的文件和操作。</p></div></div>
    <ol className="mcp-steps"><li>在侧栏底部的“设置 → API Token”创建密钥，选择范围和权限。首次连接可以选择只读。</li><li>在支持远程 MCP 的客户端中添加下方地址，选择 Streamable HTTP，并设置 <code>Authorization: Bearer &lt;你的 API Token&gt;</code> 请求头。</li><li>让 AI 先调用 <code>mono_get_access_info</code>、<code>mono_api_guide</code> 和 <code>mono_list_buckets</code>，确认授权范围、调用方式和可用存储桶，再操作文件。</li></ol>
    <div className="mcp-endpoint"><div><span>MCP 地址</span><code>{endpoint}</code></div><button className="button" type="button" onClick={() => copy(endpoint, 'MCP 地址', 'endpoint')}>{copied === 'endpoint' ? <Check size={15} /> : <Copy size={15} />}{copied === 'endpoint' ? '已复制' : '复制地址'}</button></div>
    <details className="mcp-config"><summary>通用客户端配置示例</summary><p>将占位符替换为你创建的 API Token，再填入客户端支持的 MCP 配置。此页面不需要输入密钥。</p><div className="mcp-config-toolbar"><span>mcpServers</span><button className="button small" type="button" onClick={() => copy(configuration, 'MCP 配置示例', 'config')}>{copied === 'config' ? <Check size={14} /> : <Copy size={14} />}{copied === 'config' ? '已复制' : '复制配置'}</button></div><pre><code>{configuration}</code></pre></details>
    <div className="mcp-capabilities"><ShieldCheck size={18} /><p>工具会按 Token 的范围和权限自动显示。只读 Token 只提供读取能力，单文件 Token 只能查看对应文件。ALL 允许范围内的全部存储操作，设置和 Token 管理由后台管理员处理。</p></div>
    <p className="mcp-limit">AI 可以列出文件、查看信息、读取内容、写入文本或 Base64 文件、管理删除、目录和分享。普通读取和写入每次最多 1 MiB；MCP 分片上传每片最多 5 MiB，非末片至少 5 MiB。大型文件建议使用原 API 客户端上传。</p>
    <div className="mcp-guide-actions"><div><strong>给 AI 的调用说明</strong><p>登录后可复制或下载；AI 使用 API Token 获取对应范围和权限的说明。</p></div><div><button className="button" type="button" disabled={guideBusy} onClick={copyGuide}>{guideBusy ? <LoaderCircle size={15} className="spin" /> : copied === 'guide' ? <Check size={15} /> : <Copy size={15} />}{guideBusy ? '正在读取' : copied === 'guide' ? '已复制说明' : '复制 AI 说明'}</button><a className="button" href="/api/mcp/guide" download="mono-mcp-guide.md"><Download size={15} />下载 .md</a></div></div>
    {error && <p className="mcp-error" role="alert"><AlertCircle size={16} />{error}</p>}
    {guideText && <details className="mcp-guide-preview"><summary>查看 AI 调用说明</summary><pre>{guideText}</pre></details>}
  </section>
}
