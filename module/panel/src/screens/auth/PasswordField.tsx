import { useId, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

interface PasswordFieldProps {
  label: string
  name: string
  value: string
  onChange: (value: string) => void
  autoComplete: 'current-password' | 'new-password'
  disabled?: boolean
  error?: string
  hint?: string
  visibility?: [show: string, hide: string]
}

export function PasswordField({ label, name, value, onChange, autoComplete, disabled, error, hint, visibility }: PasswordFieldProps) {
  const id = useId()
  const [visible, setVisible] = useState(false)
  const eyeClass = 'col-start-1 row-start-1 size-4 motion-safe:transition-opacity motion-safe:duration-150'

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-description` : undefined}
          className={visibility ? 'h-10 pr-10' : 'h-10'}
        />
        {visibility && (
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="absolute inset-y-0 right-0.5 my-auto text-muted-foreground transition-colors hover:text-foreground active:not-aria-[haspopup]:translate-y-0 motion-reduce:transition-none"
            aria-label={visibility[visible ? 1 : 0]}
            aria-controls={id}
            disabled={disabled}
            onClick={() => setVisible((value) => !value)}
          >
            <span className="pointer-events-none grid size-4" aria-hidden="true">
              <Eye className={cn(eyeClass, visible ? 'opacity-0' : 'opacity-100')} />
              <EyeOff className={cn(eyeClass, visible ? 'opacity-100' : 'opacity-0')} />
            </span>
          </Button>
        )}
      </div>
      {(error || hint) && (
        <p id={`${id}-description`} role={error ? 'alert' : undefined} className={error ? 'text-xs text-bad' : 'text-xs text-muted-foreground'}>
          {error ?? hint}
        </p>
      )}
    </div>
  )
}
