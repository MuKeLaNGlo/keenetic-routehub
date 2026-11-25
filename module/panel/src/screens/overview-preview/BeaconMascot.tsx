import { useId } from 'react'
import './beacon-mascot.css'

export function BeaconMascot() {
  const id = useId()
  const shell = `${id}-shell`
  const screen = `${id}-screen`
  const inset = `${id}-inset`
  const hand = `${id}-hand`

  return (
    <g className="beacon-mascot">
      <defs>
        <linearGradient id={shell} x1="0" y1="0" x2=".84" y2="1">
          <stop stopColor="#fcffef" />
          <stop offset=".48" stopColor="#e4ffe7" />
          <stop offset="1" stopColor="#8ec0bb" />
        </linearGradient>
        <linearGradient id={screen} x1="0" y1="0" x2=".76" y2="1">
          <stop stopColor="#13394a" />
          <stop offset=".64" stopColor="#0d2536" />
          <stop offset="1" stopColor="#071a2b" />
        </linearGradient>
        <linearGradient id={inset} x1="0" y1="0" x2="1" y2=".95">
          <stop stopColor="#405b62" />
          <stop offset=".53" stopColor="#193341" />
          <stop offset="1" stopColor="#7fa9a3" />
        </linearGradient>
        <linearGradient id={hand} x1="0" y1="0" x2=".7" y2="1">
          <stop stopColor="#eaffeb" />
          <stop offset=".55" stopColor="#bbebd4" />
          <stop offset="1" stopColor="#79aaa9" />
        </linearGradient>
      </defs>

      <g className="beacon-mascot__antenna">
        <path d="M226 83l8-22" fill="none" stroke="#0e2d3e" strokeWidth="7" strokeLinecap="round" />
        <path d="M226 81l8-19" fill="none" stroke="#b3dbc8" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="235" cy="59" r="9" fill="#153a47" />
        <circle className="beacon-mascot__lamp" cx="235" cy="59" r="6" fill="var(--beacon-accent)" />
        <circle cx="233.4" cy="57.2" r="1.55" fill="#f8fff1" opacity=".82" />
        <circle className="beacon-mascot__signal" cx="235" cy="59" r="12.5" fill="none" stroke="var(--beacon-accent)" strokeWidth="1.5" />
      </g>

      <g fill="none" stroke="#163747" strokeWidth="11" strokeLinecap="round">
        <path d="M160 132q-17 3-23 19" />
        <path d="M261 130q17 4 20 19" />
      </g>
      <g className="beacon-mascot__hand">
        <path d="M131 140q9-3 14 6c3 6 0 14-6 19-5 4-13 3-17-2-5-7 2-19 9-23Z" fill={`url(#${hand})`} stroke="#143647" strokeWidth="3" />
        <path d="M126 151q3-6 8-7m-11 13 5 2" fill="none" stroke="#f7fff0" strokeWidth="2" strokeLinecap="round" />
      </g>
      <path d="M280 141q10 1 16 10c5 6 3 13-3 16-6 4-14 0-19-6-4-5-5-12-1-17 2-3 4-3 7-3Z" fill={`url(#${hand})`} stroke="#143647" strokeWidth="3" />
      <path d="M279 145q5-1 10 4" fill="none" stroke="#f7fff0" strokeWidth="2" strokeLinecap="round" />

      <path d="M164 151h93l-4 12q-7 14-22 17h-42q-15-2-21-16Z" fill="#305867" stroke="#0d2a3b" strokeWidth="3" />
      <path d="M177 166q33 14 69 0" fill="none" stroke="#7fb3ad" strokeWidth="2" strokeLinecap="round" opacity=".72" />
      <ellipse cx="210" cy="175.5" rx="17" ry="3.5" fill="#102d3c" />
      <path d="M203 175h14" stroke="var(--beacon-accent)" strokeWidth="2" strokeLinecap="round" />

      <path d="M170 79q17-9 41-9 28 0 44 10c11 7 17 20 20 35l3 14c4 20-6 35-25 40q-18 5-43 5-27 0-45-5c-18-5-28-20-24-39l4-16c3-17 12-29 25-35Z" fill={`url(#${shell})`} stroke="#173a4c" strokeWidth="3" />
      <path d="M147 133q-6 25 16 34m105-34q6 25-15 34" fill="none" stroke="#346a72" strokeWidth="2" strokeLinecap="round" opacity=".35" />
      <path d="M159 94q14-20 52-20 21 0 33 5" fill="none" stroke="#fcffef" strokeWidth="2.3" strokeLinecap="round" opacity=".97" />
      <path d="M159 103q5-4 8-2m-11 8 4-2" fill="none" stroke="#688e8c" strokeWidth="1.7" strokeLinecap="round" opacity=".55" />

      <rect x="163" y="91" width="94" height="67" rx="23" fill={`url(#${inset})`} stroke="#aee1c9" strokeWidth="2" />
      <rect x="168" y="96" width="84" height="57" rx="19" fill={`url(#${screen})`} stroke="#0a1c2a" strokeWidth="2" />
      <path d="M175 116c2-10 8-14 20-14h33" fill="none" stroke="#77afb0" strokeWidth="1.7" strokeLinecap="round" opacity=".24" />
      <path d="M240 143q4-4 5-10" fill="none" stroke="#7bb8c2" strokeWidth="1.25" strokeLinecap="round" opacity=".2" />

      <g className="vpn-mascot__eyes">
        <g className="vpn-mascot__look" fill="var(--beacon-eye)">
          <rect x="187.5" y="113.5" width="10" height="16" rx="5" />
          <rect x="222.5" y="113.5" width="10" height="16" rx="5" />
          <circle cx="190.6" cy="117.1" r="1.8" fill="#effff2" opacity=".85" />
          <circle cx="225.6" cy="117.1" r="1.8" fill="#effff2" opacity=".85" />
        </g>
      </g>
      <g fill="none" stroke="var(--beacon-eye)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path className="vpn-mascot__mouth vpn-mascot__mouth--calm" d="M205 136q5 5 10 0" />
        <path className="vpn-mascot__mouth vpn-mascot__mouth--focused" d="M206 139q4-2 8 0" />
        <path className="vpn-mascot__mouth vpn-mascot__mouth--happy" d="M203 135q7 3 14 0-2 8-7 8t-7-8Z" fill="#1f6071" />
        <path className="vpn-mascot__mouth vpn-mascot__mouth--worried" d="M205.5 140q4.5-5 9 0m-27-31 9 2m27 0 9-2" />
      </g>

      <rect x="198" y="161" width="24" height="5" rx="2.5" fill="#4e7475" opacity=".76" />
      <rect x="201" y="162.25" width="18" height="2.5" rx="1.25" fill="var(--beacon-accent)" />
      <g fill="#608c88" opacity=".66">
        <circle cx="244" cy="160" r="1.3" />
        <circle cx="248" cy="159" r="1.1" />
        <circle cx="251.5" cy="157.5" r=".9" />
      </g>
    </g>
  )
}
