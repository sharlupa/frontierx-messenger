// Forward arrow for the forward sheet's shaped icon.
export function IForwardArrow({ size = 20 }: { size?: number }) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<polyline points="15 17 20 12 15 7" />
			<path d="M4 18v-1a5 5 0 0 1 5-5h11" />
		</svg>
	)
}
