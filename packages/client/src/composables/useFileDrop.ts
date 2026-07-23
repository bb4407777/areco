// 文件拖放/选件：document 级拖放监听 + 路径回填输入框。会话页/项目页共用。
// 散文件 → 上传副本落盘 data/uploads（浏览器拿不到源路径，只能复制）；
// 文件夹 → 不上传内容：只报目录名+首层子项名，服务端 Spotlight 反查源目录路径回填，agent 直读源目录（零复制，空文件夹/iCloud 占位也秒回）
import { nextTick, onMounted, onUnmounted, ref, type Ref } from 'vue'
import { useMessage } from 'naive-ui'
import { api } from '../api'

type InputEl = HTMLTextAreaElement | HTMLInputElement

interface Options {
  text: Ref<string> // 绑定的输入文本，路径追加到这里
  inputEl: Ref<InputEl | null> // 输入元素，用于回填后聚焦+光标移到末尾
  afterFill?: () => void // 回填后的额外动作（如 textarea 自动长高），可选
}

export function useFileDrop({ text, inputEl, afterFill }: Options) {
  const message = useMessage()
  const uploading = ref(false)
  const dragging = ref(false)
  const fileInputEl = ref<HTMLInputElement | null>(null)
  let dragCounter = 0

  // 路径回填输入框：追加 + 聚焦 + 光标移末尾（上传/定位两条路共用）
  async function fillPaths(insert: string) {
    text.value = text.value ? `${text.value.replace(/\s+$/, '')} ${insert} ` : `${insert} `
    afterFill?.()
    await nextTick()
    const el = inputEl.value
    if (el) {
      el.focus()
      const len = el.value.length
      el.setSelectionRange(len, len)
      el.scrollTop = el.scrollHeight
    }
  }

  async function uploadFiles(files: File[]) {
    if (!files.length || uploading.value) return
    uploading.value = true
    try {
      const paths: string[] = []
      for (const file of files) {
        const res = await fetch(`/api/files/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          body: file,
          // 强制 octet-stream：File 自带 MIME，.json 会命中 bodyparser 的 json 解析把流吞成空文件
          headers: { 'content-type': 'application/octet-stream' },
          credentials: 'same-origin',
        })
        if (res.status === 404) throw new Error('上传端点未上线：服务端还是旧版本，重启 8790 后可用')
        const parsed = (await res.json()) as { ok: boolean; data?: { path: string }; error?: { message: string } }
        if (!parsed.ok || !parsed.data) throw new Error(parsed.error?.message ?? `上传失败（HTTP ${res.status}）`)
        paths.push(parsed.data.path)
      }
      await fillPaths(paths.join(' '))
      message.success(`已上传 ${paths.length} 个文件，路径已填入输入框`)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      uploading.value = false
      if (fileInputEl.value) fileInputEl.value.value = ''
    }
  }

  // 首层子项名（只列目录首批条目，不读任何文件内容）：给服务端核验同名候选目录用
  function firstLevelNames(dir: FileSystemDirectoryEntry, limit: number): Promise<string[]> {
    return new Promise((resolve) => {
      dir.createReader().readEntries(
        (entries) => resolve(entries.slice(0, limit).map((e) => e.name)),
        () => resolve([]),
      )
    })
  }

  // 拖入文件夹：定位源路径回填（不上传）。定位不到只报错提示粘路径，绝不悄悄退回慢速整包上传
  async function locateDirs(dirs: FileSystemDirectoryEntry[]) {
    for (const dir of dirs) {
      try {
        const samples = await firstLevelNames(dir, 5)
        const { paths } = await api.post<{ paths: string[] }>('/api/files/locate-dir', { name: dir.name, samples })
        if (!paths.length) {
          message.error(`未能定位「${dir.name}」的源路径（可能不在 Spotlight 索引内）——请直接把文件夹路径粘贴进输入框`)
          continue
        }
        await fillPaths(paths[0])
        if (paths.length > 1) message.warning(`「${dir.name}」同名目录有 ${paths.length} 处，已填最可能的一处；不对请改为粘贴路径`)
        else message.success(`已填入「${dir.name}」的源路径（未上传内容，agent 直读源目录）`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        message.error(msg.includes('404') ? '文件夹定位端点未上线：服务端还是旧版本，重启 8790 后可用' : `定位「${dir.name}」失败：${msg}`)
      }
    }
  }

  function pickFiles() {
    fileInputEl.value?.click()
  }
  function onInputChange(e: Event) {
    const files = (e.target as HTMLInputElement).files
    if (files) void uploadFiles(Array.from(files))
  }

  // document 级拖放监听（组件挂载即覆盖整页）：计数器解子元素 dragenter/dragleave 抖动
  function onDragEnter(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return
    dragCounter++
    dragging.value = true
  }
  function onDragLeave() {
    dragCounter = Math.max(0, dragCounter - 1)
    if (dragCounter === 0) dragging.value = false
  }
  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault() // 必须，否则 drop 不触发且浏览器会打开文件
  }
  async function onDrop(e: DragEvent) {
    dragCounter = 0
    dragging.value = false
    if (!e.dataTransfer) return
    e.preventDefault() // 必须在任何 await 之前同步调，否则浏览器打开文件/文件夹
    // webkitGetAsEntry 必须在 drop 事件同步阶段全部取出（items 列表事件一过就失效）
    const dt = e.dataTransfer
    const dirs: FileSystemDirectoryEntry[] = []
    const fileEntries: FileSystemFileEntry[] = []
    if (dt.items?.length) {
      for (let i = 0; i < dt.items.length; i++) {
        const en = dt.items[i].webkitGetAsEntry()
        if (!en) continue
        if (en.isDirectory) dirs.push(en as FileSystemDirectoryEntry)
        else if (en.isFile) fileEntries.push(en as FileSystemFileEntry)
      }
    }
    const files: File[] = []
    for (const fe of fileEntries) {
      try {
        files.push(await new Promise<File>((res, rej) => fe.file(res, rej)))
      } catch {
        // 单个文件取不出（被移走/权限）：跳过，不拖累其余
      }
    }
    // 旧浏览器无 entries API：退回 dt.files（文件夹在这条路只是空壳，无从识别）
    if (!dirs.length && !files.length && dt.files?.length) files.push(...Array.from(dt.files))
    if (dirs.length) await locateDirs(dirs)
    if (files.length) await uploadFiles(files)
  }

  onMounted(() => {
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
  })
  onUnmounted(() => {
    document.removeEventListener('dragenter', onDragEnter)
    document.removeEventListener('dragover', onDragOver)
    document.removeEventListener('dragleave', onDragLeave)
    document.removeEventListener('drop', onDrop)
  })

  return { dragging, uploading, fileInputEl, pickFiles, onInputChange }
}
