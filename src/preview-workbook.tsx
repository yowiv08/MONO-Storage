import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, LoaderCircle, Table2 } from 'lucide-react'
import { pageMerge, workbookColumnName, WORKBOOK_PAGE_ROWS, type WorkbookPage } from './workbook-model.ts'

type WorkerResult = { id: number; names?: string[]; page?: WorkbookPage; error?: string }

export function WorkbookPreview({ data, kind, mode }: { data: ArrayBuffer; kind: 'workbook' | 'csv'; mode: 'preview' | 'source' }) {
  const [names, setNames] = useState<string[]>([])
  const [selected, setSelected] = useState('')
  const [page, setPage] = useState(0)
  const [result, setResult] = useState<WorkbookPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const worker = useRef<Worker | null>(null)
  const initialized = useRef(false)
  const sequence = useRef(0)
  const currentRequest = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function send(value: { type: 'open'; data: ArrayBuffer; kind: 'workbook' | 'csv' } | { type: 'page'; name: string; page: number }, transfer: Transferable[] = []) {
    const active = worker.current
    if (!active) return
    const id = ++sequence.current
    currentRequest.current = id
    setLoading(true); setError('')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (currentRequest.current !== id) return
      active.terminate(); worker.current = null; setLoading(false); setError('表格内容较复杂，解析已停止，请下载后查看。')
    }, 15000)
    active.postMessage({ id, ...value }, transfer)
  }

  useEffect(() => {
    setNames([]); setSelected(''); setPage(0); setResult(null); setError(''); setLoading(true)
    const active = new Worker(new URL('./workbook-worker.ts', import.meta.url), { type: 'module' })
    worker.current = active
    initialized.current = false
    active.onmessage = (event: MessageEvent<WorkerResult>) => {
      if (worker.current !== active || event.data.id !== currentRequest.current) return
      if (timer.current) clearTimeout(timer.current)
      if (event.data.error) { setError(event.data.error); setLoading(false); return }
      if (event.data.names) { initialized.current = true; setNames(event.data.names); setSelected(event.data.names[0] || ''); send({ type: 'page', name: event.data.names[0] || '', page: 0 }) }
      if (event.data.page) { setResult(event.data.page); setLoading(false) }
    }
    active.onerror = () => { if (worker.current === active) { if (timer.current) clearTimeout(timer.current); setError('无法解析表格，请下载后查看。'); setLoading(false) } }
    const copy = data.slice(0)
    send({ type: 'open', data: copy, kind }, [copy])
    return () => { active.terminate(); if (worker.current === active) worker.current = null; if (timer.current) clearTimeout(timer.current); currentRequest.current = ++sequence.current }
  }, [data, kind])

  useEffect(() => { if (selected && worker.current && initialized.current) send({ type: 'page', name: selected, page }) }, [selected, page])
  const pages = Math.max(1, Math.ceil((result?.rowCount || 0) / WORKBOOK_PAGE_ROWS))
  const ready = result && result.name === selected && result.page === page && !loading && !error
  const first = result ? result.startRow + page * WORKBOOK_PAGE_ROWS + 1 : 0
  const last = result ? first + result.rows.length - 1 : 0

  return <div className="workbook-preview">
    {names.length > 0 && <div className="workbook-controls"><label><Table2 size={16} /><span>工作表</span><select aria-label="选择工作表" value={selected} disabled={loading} onChange={event => { setPage(0); setSelected(event.target.value) }}>{names.map(name => <option key={name} value={name}>{name}</option>)}</select></label>{result && <span className="workbook-size">{result.fullRowCount} 行 × {result.fullColumnCount} 列</span>}</div>}
    {loading ? <div className="document-loading" role="status"><LoaderCircle size={22} className="spin" />正在读取工作表</div> : error ? <div className="document-error" role="alert">{error}</div> : ready ? <>
      {!result.rowCount ? <div className="document-empty">这个工作表没有内容。</div> : mode === 'source' ? <div className="workbook-source"><p className="document-note">当前工作表以制表符分隔的文本显示，公式保留为原始表达式；这里展示第 {first}–{last} 行。二进制文件原始内容可下载查看。</p><pre>{result.source}</pre></div> : <div className="workbook-table-scroll" tabIndex={0} role="region" aria-label={`${selected} 工作表内容`}><table className="workbook-table"><colgroup><col className="workbook-row-column" />{result.widths.map((width, index) => <col key={index} style={{ width }} />)}</colgroup><thead><tr><th className="workbook-corner" scope="col" aria-label="行号" />{result.widths.map((_, index) => <th key={index} scope="col">{workbookColumnName(result.startColumn + index)}</th>)}</tr></thead><tbody>{result.rows.map((row, rowIndex) => <tr key={rowIndex} style={{ height: result.heights[rowIndex] }}><th scope="row">{first + rowIndex}</th>{row.map((cell, columnIndex) => {
        const merge = pageMerge(result, rowIndex, columnIndex)
        if (merge.skip) return null
        const mergedCell = merge.sourceKey ? result.mergeCells[merge.sourceKey] : cell
        return <td key={columnIndex} rowSpan={merge.rowSpan} colSpan={merge.colSpan} className={mergedCell?.numeric ? 'workbook-number' : ''} title={mergedCell?.formula ? `${mergedCell.text}\n公式：${mergedCell.formula}` : mergedCell?.text}>{mergedCell?.text || ''}</td>
      })}</tr>)}</tbody></table></div>}
      {result.warnings.map(warning => <p key={warning} className="document-note workbook-warning">{warning}</p>)}
      {result.rowCount > 0 && <div className="workbook-pagination"><span>第 {first}–{last} 行，共 {result.rowCount} 行{result.fullRowCount > result.rowCount ? '可预览' : ''}</span><div><button className="button" aria-label="工作表上一页" disabled={page === 0 || loading} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} />上一页</button><span>{page + 1} / {pages}</span><button className="button" aria-label="工作表下一页" disabled={page + 1 >= pages || loading} onClick={() => setPage(value => value + 1)}>下一页<ChevronRight size={16} /></button></div></div>}
      {mode === 'preview' && <p className="document-note workbook-note">按文件保存的数值与常用格式显示，公式和宏不会执行。复杂图表、样式或打印排版请下载后查看。</p>}
    </> : null}
  </div>
}
