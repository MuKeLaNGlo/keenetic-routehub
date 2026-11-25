import { useEffect, useId, useRef, type ReactNode } from 'react'

export function VpnMascotScene({ children }: { children: ReactNode }) {
  const art = useRef<SVGSVGElement>(null)
  const id = useId()
  const paint = (name: string) => `url(#${id}-${name})`

  useEffect(() => {
    const svg = art.current
    if (!svg) return

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let idleTimer = 0
    let x = 0
    let y = 0

    function relax() {
      svg?.removeAttribute('data-tracking')
      window.clearTimeout(idleTimer)
      window.cancelAnimationFrame(frame)
      frame = 0
      idleTimer = 0
    }

    function follow(event: PointerEvent) {
      if (event.pointerType === 'touch' || motion.matches || !svg) return

      x = event.clientX
      y = event.clientY
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0
          const box = svg.getBoundingClientRect()
          const dx = x - (box.left + box.width * 0.5)
          const dy = y - (box.top + box.height * 0.51)
          const reach = Math.max(120, Math.hypot(dx, dy))
          svg.style.setProperty('--mascot-look-x', `${(dx / reach * 4.6).toFixed(2)}px`)
          svg.style.setProperty('--mascot-look-y', `${(dy / reach * 3.4).toFixed(2)}px`)
          svg.style.setProperty('--mascot-look-turn', `${(dx / reach * 2.8).toFixed(2)}deg`)
          svg.setAttribute('data-tracking', '')
        })
      }

      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(relax, 1900)
    }

    function leave(event: PointerEvent) {
      if (!event.relatedTarget) relax()
    }

    window.addEventListener('pointermove', follow, { passive: true })
    window.addEventListener('pointerout', leave, { passive: true })
    window.addEventListener('blur', relax)
    motion.addEventListener('change', relax)

    return () => {
      window.removeEventListener('pointermove', follow)
      window.removeEventListener('pointerout', leave)
      window.removeEventListener('blur', relax)
      motion.removeEventListener('change', relax)
      relax()
    }
  }, [])

  return (
    <svg ref={art} className="vpn-mascot" viewBox="0 0 420 240" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${id}-shadow`}>
          <stop stopColor="#071325" stopOpacity=".45" />
          <stop offset="1" stopColor="#071325" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g className="vpn-mascot__orbit">
        <ellipse cx="210" cy="147" rx="155" ry="65" transform="rotate(-11 210 147)" />
        <ellipse cx="210" cy="147" rx="122" ry="48" transform="rotate(-11 210 147)" />
        <path d="M60 168a155 65-11 0 0 301-50" className="vpn-mascot__wire" pathLength="100" />
        <path d="M62 119v8m-4-4h8M352 85v8m-4-4h8M325 193v8m-4-4h8" className="vpn-mascot__marks" />
        <circle cx="75" cy="181" r="3" className="vpn-mascot__node" />
        <circle cx="354" cy="113" r="3" className="vpn-mascot__node" />
      </g>

      <g className="vpn-mascot__stream">
        <path d="M51 137c23-31 71-54 132-60m40-5c51-2 99 10 132 31" pathLength="100" />
        <path d="M69 177c40 30 106 40 174 29 53-8 95-27 122-52" pathLength="100" />
        <path d="M115 204c37 11 82 13 127 6" pathLength="100" />
      </g>

      <ellipse className="vpn-mascot__shadow" cx="211" cy="177" rx="131" ry="28" fill={paint('shadow')} />

      <g className="vpn-mascot__pose">
        <g className="vpn-mascot__steer">
          {children}
        </g>
      </g>

      <g className="vpn-mascot__signals">
        <circle cx="119" cy="99" r="5.5" />
        <circle cx="109" cy="82" r="2.8" />
        <circle cx="125" cy="71" r="1.6" />
      </g>
      <g className="vpn-mascot__sparkles" fill="none" strokeLinecap="round">
        <path d="M118 74v18m-9-9h18M306 95v14m-7-7h14M337 151v16m-8-8h16" />
        <path d="M103 162v8m-4-4h8M292 66v8m-4-4h8" />
      </g>
      <g className="vpn-mascot__break" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="m332 111-10 11 10 4-11 12" />
        <path d="m102 95-5-6m10 0-1-7m-10 19-7-1" />
      </g>
    </svg>
  )
}
