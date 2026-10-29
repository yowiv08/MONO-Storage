export const tokenPermissionDefinitions = [
  { id: 'read', label: '读取文件', description: '列出文件、查看信息、预览和下载。', file: true },
  { id: 'write', label: '写入文件', description: '上传、覆盖文件，包括分片上传。', file: true },
  { id: 'delete', label: '删除文件', description: '删除授权范围内的文件。', file: true },
  { id: 'create_folder', label: '创建目录', description: '在授权存储桶中创建目录。', file: false },
  { id: 'delete_folder', label: '删除目录', description: '删除授权存储桶中的空目录。', file: false },
  { id: 'share', label: '管理分享', description: '创建、查看和撤销文件分享；创建分享需要读取权限。', file: true },
] as const

export type TokenPermission = typeof tokenPermissionDefinitions[number]['id']
export type TokenScope = { type: 'all' } | { type: 'bucket'; bucket: string } | { type: 'file'; bucket: string; key: string }

export const allTokenPermissions: TokenPermission[] = tokenPermissionDefinitions.map(item => item.id)
export const fileTokenPermissions: TokenPermission[] = tokenPermissionDefinitions.filter(item => item.file).map(item => item.id)

export function permissionsForScope(scope: TokenScope): TokenPermission[] {
  return scope.type === 'file' ? [...fileTokenPermissions] : [...allTokenPermissions]
}

export function permissionPreset(preset: 'read' | 'write' | 'read_write' | 'all', scope: TokenScope): TokenPermission[] {
  return preset === 'all' ? permissionsForScope(scope) : preset === 'read_write' ? ['read', 'write'] : [preset]
}
