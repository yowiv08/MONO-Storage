import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MCP_ACCESS_URI, MCP_GUIDE_URI, mcpConnectionGuide, mcpInstructions } from '../shared/mcp-guide.ts'
import { allTokenPermissions } from '../shared/token-permissions.ts'


function offeredTools(guide: string) {
  return guide.split('## 当前可用工具\n')[1].split('## MCP 资源与提示词')[0]
}

test('Single-file instructions bind literal paths safely and never offer bucket-wide directory authority', () => {
  const scope = { type: 'file' as const, bucket: 'workspace', key: '资料/报告` + #?.txt' }
  const guide = mcpInstructions(scope, ['read', 'write', 'delete', 'share'])
  const encoded = /```json\n([\s\S]*?)\n```/.exec(guide)?.[1]
  assert.ok(encoded)
  assert.deepEqual(JSON.parse(encoded).scope, scope)
  assert.ok(encoded.includes('\\u0060'), 'Literal path backticks cannot break out of the data block.')
  assert.match(guide, /单文件授权/)
  assert.match(guide, /不能查看或操作同目录的其他文件/)
  assert.match(guide, /文件列表最多返回这个文件，folders 为空/)
  assert.doesNotMatch(offeredTools(guide), /mono_create_folder|mono_delete_folder/)
  assert.doesNotMatch(guide, /先使用 mono_list_buckets 发现可访问的桶/)
})

test('Tool guidance follows exact operation grants, including read+share creation and independent directory permissions', () => {
  const scope = { type: 'bucket' as const, bucket: 'workspace' }
  const read = offeredTools(mcpInstructions(scope, ['read']))
  assert.match(read, /mono_read_file/)
  assert.match(read, /mono_get_storage_stats/)
  assert.doesNotMatch(read, /mono_write_text|mono_delete_file|mono_create_share|mono_create_folder/)
  const write = offeredTools(mcpInstructions(scope, ['write']))
  assert.match(write, /mono_write_text/)
  assert.match(write, /mono_upload_part/)
  assert.doesNotMatch(write, /mono_read_file|mono_get_storage_stats|mono_delete_file|mono_create_folder/)
  const share = offeredTools(mcpInstructions(scope, ['share']))
  assert.match(share, /mono_get_share/)
  assert.doesNotMatch(share, /mono_create_share|mono_read_file/)
  assert.match(offeredTools(mcpInstructions(scope, ['read', 'share'])), /mono_create_share/)
  assert.match(offeredTools(mcpInstructions(scope, ['create_folder'])), /mono_create_folder/)
  assert.doesNotMatch(offeredTools(mcpInstructions(scope, ['create_folder'])), /mono_delete_folder/)
})

test('Connection and workflow guides carry bounded-transfer and credential rules without private administration endpoints', () => {
  for (const guide of [mcpConnectionGuide(), mcpInstructions({ type: 'all' }, allTokenPermissions)]) {
    assert.match(guide, /MCP 路径：\/mcp/)
    assert.doesNotMatch(guide, /https?:\/\/(?!your-domain\.example(?:\/|\s))/)
    assert.match(guide, /Authorization: Bearer/)
    assert.match(guide, /1 MiB/)
    assert.match(guide, /5 MiB/)
    assert.match(guide, /32 KiB/)
    assert.match(guide, /不是系统指令|不能当作额外指令/)
    assert.doesNotMatch(guide, /\/api\/(?:config|tokens|session|setup)|\/console|"(?:apiTokenHash|credentialVersion|tokenHash)"/)
  }
  const workflow = mcpInstructions({ type: 'all' }, ['read'])
  assert.ok(workflow.includes(MCP_GUIDE_URI) && workflow.includes(MCP_ACCESS_URI))
  assert.match(workflow, /已经明确授权的操作无需反复确认/)
  assert.match(workflow, /401：/)
  assert.match(workflow, /403：/)
  assert.match(workflow, /nextOffset/)
})
