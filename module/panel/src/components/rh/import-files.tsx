import { useRef } from 'react'
import { FileUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

function fileKey(file: File) {
  return `${file.name}/${file.size}/${file.lastModified}`
}

export function ImportFiles({ files, onChange, label, accept, multiple = false, disabled }: {
  files: File[]
  onChange: (files: File[]) => void
  label: string
  accept?: string
  multiple?: boolean
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const add = (incoming: FileList | null) => {
    if (!incoming?.length || disabled) return
    if (!multiple) {
      onChange([incoming[0]])
      return
    }
    const merged = new Map([...files, ...Array.from(incoming)].map((file) => [fileKey(file), file]))
    onChange([...merged.values()])
  }

  return (
    <div
      className="space-y-2 rounded-lg border border-dashed p-2.5"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); add(event.dataTransfer.files) }}
    >
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label={label}
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => {
          add(event.currentTarget.files)
          event.currentTarget.value = ''
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => input.current?.click()}>
          <FileUp aria-hidden="true" /> {label}
        </Button>
        <span className="text-xs text-muted-foreground">Можно перетащить {multiple ? 'файлы' : 'файл'} сюда</span>
      </div>
      {files.length > 0 && (
        <ul className="space-y-1" aria-label="Выбранные файлы">
          {files.map((file, index) => (
            <li key={fileKey(file)} className="flex items-center justify-between gap-2 rounded-md bg-muted/55 px-2 py-0.5">
              <span className="min-w-0 truncate text-xs" title={file.name}>{file.name}</span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Убрать ${file.name}`} disabled={disabled} onClick={() => onChange(files.filter((_, i) => i !== index))}>
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
