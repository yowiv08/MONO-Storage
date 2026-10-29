import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { X, Download, Copy, File, FileText, Image, Film, Music2, Folder, Check, ChevronDown, Code2, LockKeyhole, ArrowUpRight, AlertCircle, CheckCircle2, LoaderCircle, KeyRound, RefreshCw, Eye, EyeOff } from 'lucide-react'
import { api, bucketPath, objectUrl, type SessionState, type StoredObject } from './api'
import { baseName, fileKind, formatBytes, formatDate } from './format'
import { ThemeToggle } from './theme'
import { McpGuide } from './mcp-guide'

export { FileGlyph, Modal } from './common-components'
import { Preview as CommonPreview } from './common-components'

export function Preview({ bucket, object, sourceUrl }: { bucket: string; object: StoredObject; sourceUrl?: string }) {
  return <CommonPreview object={object} sourceUrl={sourceUrl || objectUrl(bucket, object.key)} />
}

export function ApiGuide({ bucket, notify }: { bucket: string; notify: (message: string) => void }) {
  const [example, setExample] = useState<'curl' | 'javascript' | 'python'>('curl')
  const [action, setAction] = useState<'upload' | 'list' | 'download' | 'delete'>('upload')
  const origin = location.origin
  const endpoint = `${origin}${bucketPath(bucket, action === 'list' ? 'objects' : 'object')}${action === 'list' ? '?prefix=documents/' : '?key=documents/hello.txt'}`
  const examples = {
    curl: {
      upload: `curl -X PUT '${endpoint}' \\\n  -H "Authorization: Bearer $MONO_API_TOKEN" \\\n  -H 'Content-Type: text/plain' \\\n  --data-binary @hello.txt`,
      list: `curl '${endpoint}' \\\n  -H "Authorization: Bearer $MONO_API_TOKEN"`,
      download: `curl '${endpoint}' \\\n  -H "Authorization: Bearer $MONO_API_TOKEN" \\\n  -o hello.txt`,
      delete: `curl -X DELETE '${endpoint}' \\\n  -H "Authorization: Bearer $MONO_API_TOKEN"`,
    },
    javascript: {
      upload: `import { readFile } from 'node:fs/promises';\n\nconst response = await fetch('${endpoint}', {\n  method: 'PUT',\n  headers: {\n    Authorization: \`Bearer \${process.env.MONO_API_TOKEN}\`,\n    'Content-Type': 'text/plain',\n  },\n  body: await readFile('hello.txt'),\n});\nif (!response.ok) throw new Error(await response.text());\nconsole.log(await response.json());`,
      list: `const response = await fetch('${endpoint}', {\n  headers: { Authorization: \`Bearer \${process.env.MONO_API_TOKEN}\` },\n});\nif (!response.ok) throw new Error(await response.text());\nconsole.log(await response.json());`,
      download: `import { writeFile } from 'node:fs/promises';\n\nconst response = await fetch('${endpoint}', {\n  headers: { Authorization: \`Bearer \${process.env.MONO_API_TOKEN}\` },\n});\nif (!response.ok) throw new Error(await response.text());\nawait writeFile('hello.txt', Buffer.from(await response.arrayBuffer()));`,
      delete: `const response = await fetch('${endpoint}', {\n  method: 'DELETE',\n  headers: { Authorization: \`Bearer \${process.env.MONO_API_TOKEN}\` },\n});\nif (!response.ok) throw new Error(await response.text());`,
    },
    python: {
      upload: `import os, requests\n\nwith open('hello.txt', 'rb') as file:\n    response = requests.put(\n        '${endpoint}',\n        headers={\n            'Authorization': f'Bearer {os.environ["MONO_API_TOKEN"]}',\n            'Content-Type': 'text/plain',\n        },\n        data=file,\n    )\nresponse.raise_for_status()\nprint(response.json())`,
      list: `import os, requests\n\nresponse = requests.get(\n    '${endpoint}',\n    headers={'Authorization': f'Bearer {os.environ["MONO_API_TOKEN"]}'},\n)\nresponse.raise_for_status()\nprint(response.json())`,
      download: `import os, requests\n\nresponse = requests.get(\n    '${endpoint}',\n    headers={'Authorization': f'Bearer {os.environ["MONO_API_TOKEN"]}'},\n    stream=True,\n)\nresponse.raise_for_status()\nwith open('hello.txt', 'wb') as file:\n    for chunk in response.iter_content(1024 * 1024):\n        file.write(chunk)`,
      delete: `import os, requests\n\nresponse = requests.delete(\n    '${endpoint}',\n    headers={'Authorization': f'Bearer {os.environ["MONO_API_TOKEN"]}'},\n)\nresponse.raise_for_status()`,
    },
  }
  return <div className="api-page"><div className="page-title-row"><div><div className="eyebrow">DEVELOPER ACCESS</div><h1>API 访问</h1><p className="page-description">用几行代码，连接你的文件。</p></div><span className="tag"><LockKeyhole size={12} />Bearer Token 认证</span></div>
    <div className="api-intro"><div className="api-intro-icon"><Code2 size={26} strokeWidth={1.4} /></div><div><h3>同一个存储桶，两种访问方式。</h3><p>网页和 API 访问相同的对象。在“设置”创建 API Token，为应用选择文件范围和读取、写入、删除等权限。</p></div></div>
    <McpGuide notify={notify} />
    <div className="api-layout"><div className="api-reference"><h3>接口</h3>{[{ method: 'PUT', path: '/object?key=…', label: '上传对象', value: 'upload' }, { method: 'GET', path: '/objects?prefix=…', label: '列出对象', value: 'list' }, { method: 'GET', path: '/object?key=…', label: '下载对象', value: 'download' }, { method: 'DELETE', path: '/object?key=…', label: '删除对象', value: 'delete' }].map(item => <button className={`endpoint ${action === item.value ? 'active' : ''}`} key={item.value} onClick={() => setAction(item.value as typeof action)}><span className="method">{item.method}</span><span><strong>{item.label}</strong><code>{item.path}</code></span><ArrowUpRight size={15} /></button>)}<div className="api-notes"><span className="eyebrow">GOOD TO KNOW</span><p>对象路径支持中文和目录，调用时使用 URL 编码。</p><p>同名上传默认返回 409。确认覆盖时添加 <code>overwrite=true</code>。</p><p>大文件使用分片上传接口，完整说明见项目文档。</p></div></div><div className="code-card"><div className="code-tabs"><div>{(['curl', 'javascript', 'python'] as const).map(item => <button key={item} className={example === item ? 'active' : ''} onClick={() => setExample(item)}>{item === 'javascript' ? 'JavaScript' : item === 'python' ? 'Python' : 'cURL'}</button>)}</div><button className="icon-button" aria-label="复制 API 示例" onClick={async () => { try { await navigator.clipboard.writeText(examples[example][action]); notify('API 示例已复制') } catch { notify('请手动复制代码') } }}><Copy size={16} /></button></div><pre>{examples[example][action]}</pre><div className="code-footer"><span className="status-dot" />将 MONO_API_TOKEN 设置为你的访问密钥</div></div></div>
    <div className="api-base"><div><span className="eyebrow">BASE URL</span><code>{origin}/api/buckets/{bucket}</code></div><button className="button" onClick={async () => { await navigator.clipboard.writeText(`${origin}/api/buckets/${bucket}`); notify('基础地址已复制') }}><Copy size={14} />复制地址</button></div>
  </div>
}

export { Login, SetupWizard } from './auth-views'

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => { const timer = setTimeout(onClose, 4500); return () => clearTimeout(timer) }, [message, onClose])
  return <div className="toast" role="status"><CheckCircle2 size={17} /><span>{message}</span><button onClick={onClose} aria-label="关闭提示"><X size={14} /></button></div>
}
