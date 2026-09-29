import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

export type SegOption<T extends string> = { value: T; label: string }

/**
 * Segmented control with a thumb that slides between options.
 * Pure DOM measurement, so labels of different languages stay aligned.
 */
export function SegToggle<T extends string>({
	options,
	value,
	onChange,
	ariaLabel,
}: {
	options: SegOption<T>[]
	value: T
	onChange: (value: T) => void
	ariaLabel?: string
}) {
	const listRef = useRef<HTMLDivElement | null>(null)
	const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)

	const measure = useCallback(() => {
		const list = listRef.current
		if (!list) return
		const index = options.findIndex((option) => option.value === value)
		if (index < 0) {
			setThumb(null)
			return
		}
		const buttons = list.querySelectorAll<HTMLButtonElement>(".seg-btn")
		const button = buttons[index]
		if (!button) return
		setThumb({ left: button.offsetLeft, width: button.offsetWidth })
	}, [options, value])

	useLayoutEffect(() => {
		measure()
	}, [measure])

	useEffect(() => {
		const onResize = () => measure()
		window.addEventListener("resize", onResize)
		return () => window.removeEventListener("resize", onResize)
	}, [measure])

	return (
		<div className="seg" role="group" aria-label={ariaLabel} ref={listRef}>
			{thumb ? (
				<span
					className="seg-thumb"
					aria-hidden="true"
					style={{ width: thumb.width, transform: "translateX(" + String(thumb.left - 3) + "px)" }}
				/>
			) : null}
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					className={"seg-btn" + (option.value === value ? " active" : "")}
					aria-pressed={option.value === value}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	)
}
