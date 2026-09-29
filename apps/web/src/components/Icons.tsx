type IconProps = { size?: number; className?: string }

export function IconEmoji({ size = 18, className }: IconProps) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
			<circle cx="12" cy="12" r="9" />
			<path d="M8 14s1.5 2 4 2 4-2 4-2" />
			<line x1="9" y1="9.5" x2="9.01" y2="9.5" />
			<line x1="15" y1="9.5" x2="15.01" y2="9.5" />
		</svg>
	)
}

export function IconReply({ size = 18, className }: IconProps) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
			<polyline points="9 17 4 12 9 7" />
			<path d="M20 18v-1a5 5 0 0 0-5-5H4" />
		</svg>
	)
}

export function IconForward({ size = 18, className }: IconProps) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
			<polyline points="15 17 20 12 15 7" />
			<path d="M4 18v-1a5 5 0 0 1 5-5h11" />
		</svg>
	)
}

export function IconMore({ size = 18, className }: IconProps) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
			<path d="M6 12h.01" />
			<path d="M12 12h.01" />
			<path d="M18 12h.01" />
		</svg>
	)
}

export function IconPin({ size = 14, className }: IconProps) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
			<path d="M12 21s-6.5-5.5-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.5 12 21 12 21z" />
			<circle cx="12" cy="10.5" r="2.3" />
		</svg>
	)
}

export function IconBellOff({ size = 14, className }: IconProps) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
			<path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 2h16z" />
			<path d="M10 19a2 2 0 0 0 4 0" />
			<line x1="3" y1="3" x2="21" y2="21" />
		</svg>
	)
}

export function IconBookmark({ size = 20, className }: IconProps) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" className={className}>
			<path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1z" />
		</svg>
	)
}

export function IconClose({ size = 18, className }: IconProps) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
			<line x1="6" y1="6" x2="18" y2="18" />
			<line x1="18" y1="6" x2="6" y2="18" />
		</svg>
	)
}

export function IconFile({ size = 16, className }: IconProps) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
			<path d="M14 2v6h6" />
		</svg>
	)
}