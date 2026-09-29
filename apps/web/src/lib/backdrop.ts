import type { MouseEvent, PointerEvent } from "react"

// Props for a dialog backdrop: a click on the empty area around the dialog
// closes it. The press has to start on the backdrop as well, so selecting text
// in a field and releasing the mouse outside does not throw the input away,
// and a click on a nested dialog's backdrop never closes the parent too. The
// flag lives on the element, so a re-render between press and release is fine.
export function backdropClose(onClose: () => void) {
	return {
		onPointerDown: (event: PointerEvent<HTMLElement>) => {
			event.currentTarget.dataset.pressed = event.target === event.currentTarget ? "1" : ""
		},
		onClick: (event: MouseEvent<HTMLElement>) => {
			const startedHere = event.currentTarget.dataset.pressed === "1"
			event.currentTarget.dataset.pressed = ""
			if (startedHere && event.target === event.currentTarget) onClose()
		},
	}
}
