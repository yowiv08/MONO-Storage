import * as mammoth from 'mammoth'
import { validateDocumentArchive } from './preview-archive'

const scope = self as unknown as { onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null; postMessage: (data: unknown) => void }
scope.onmessage = async event => {
  try {
    validateDocumentArchive(event.data)
    let imageBytes = 0
    let imageCount = 0
    let skippedImages = false
    const html = await mammoth.convertToHtml({ arrayBuffer: event.data }, {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => p:fresh", "p[style-name='Heading 1'] => h2:fresh", "p[style-name='Heading 2'] => h3:fresh"],
      convertImage: mammoth.images.imgElement(async image => {
        if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(image.contentType) || imageCount >= 30) { skippedImages = true; return { src: '' } }
        const data = new Uint8Array(await image.readAsArrayBuffer())
        if (data.byteLength > 2 * 1024 * 1024 || imageBytes + data.byteLength > 10 * 1024 * 1024) { skippedImages = true; return { src: '' } }
        imageBytes += data.byteLength
        imageCount++
        let binary = ''
        for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192))
        return { src: `data:${image.contentType};base64,${btoa(binary)}` }
      }),
    })
    const text = await mammoth.extractRawText({ arrayBuffer: event.data })
    const textLimit = 2 * 1024 * 1024
    const htmlLimit = 6 * 1024 * 1024
    scope.postMessage({ html: html.value.length <= htmlLimit ? html.value : '', text: text.value.slice(0, textLimit), textTruncated: text.value.length > textLimit, previewError: html.value.length > htmlLimit ? '文档排版内容较大，请查看原文或下载文件。' : '', skippedImages, warnings: html.messages.some(message => message.type === 'warning') })
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : '无法解析这份 Word 文档。' })
  }
}
