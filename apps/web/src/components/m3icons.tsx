// Outlined 24px icons for the Material 3 Expressive surfaces. Drawn as strokes
// in currentColor so they follow the theme and the tonal container around them.

import type { ReactNode } from "react"

type Props = { size?: number; className?: string }

function Svg({ size = 20, className, children, fill }: Props & { children: ReactNode; fill?: boolean }) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			fill={fill ? "currentColor" : "none"}
			stroke={fill ? "none" : "currentColor"}
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={className}
		>
			{children}
		</svg>
	)
}

export const IPerson = (p: Props) => <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 20.5c1.2-4 4.3-6 8-6s6.8 2 8 6" /></Svg>
export const IPeople = (p: Props) => <Svg {...p}><circle cx="9" cy="8.5" r="3.5" /><path d="M2.5 19.5c.9-3.4 3.4-5.2 6.5-5.2s5.6 1.8 6.5 5.2" /><path d="M15.5 5.3a3.5 3.5 0 0 1 0 6.4" /><path d="M17.5 14.6c2 .7 3.4 2.3 4 4.9" /></Svg>
export const ILock = (p: Props) => <Svg {...p}><rect x="4.5" y="10.5" width="15" height="10" rx="3" /><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" /><path d="M12 14.5v2" /></Svg>
export const IKey = (p: Props) => <Svg {...p}><circle cx="8" cy="15" r="4.5" /><path d="M11.3 11.7 20 3" /><path d="M16.5 6.5l2.5 2.5" /><path d="M14.5 8.5l2 2" /></Svg>
export const IShield = (p: Props) => <Svg {...p}><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6z" /><path d="m9 12 2.2 2.2L15.5 10" /></Svg>
export const IPalette = (p: Props) => <Svg {...p}><path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-1.3-1-1.5-1-2.7 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z" /><circle cx="7.5" cy="11.5" r="1.2" /><circle cx="10" cy="7.5" r="1.2" /><circle cx="14.5" cy="7.5" r="1.2" /></Svg>
export const IBell = (p: Props) => <Svg {...p}><path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 2h16z" /><path d="M10 20a2 2 0 0 0 4 0" /></Svg>
export const IBellOff = (p: Props) => <Svg {...p}><path d="M18 16v-5a6 6 0 0 0-9.6-4.8" /><path d="M6 11v5l-2 2h13" /><path d="M10 20a2 2 0 0 0 4 0" /><path d="M3 3l18 18" /></Svg>
export const IDevices = (p: Props) => <Svg {...p}><rect x="3" y="5" width="13" height="10" rx="2" /><path d="M6 19h7" /><rect x="17" y="9" width="4.5" height="10" rx="1.4" /></Svg>
export const IPhone = (p: Props) => <Svg {...p}><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M11 18.5h2" /></Svg>
export const IBot = (p: Props) => <Svg {...p}><rect x="4" y="8" width="16" height="11" rx="4" /><path d="M12 8V4.5" /><circle cx="12" cy="3.5" r="1" /><circle cx="9" cy="13" r="1.3" /><circle cx="15" cy="13" r="1.3" /><path d="M2 12.5v2.5M22 12.5v2.5" /></Svg>
export const ICode = (p: Props) => <Svg {...p}><path d="m8 8-4.5 4L8 16" /><path d="m16 8 4.5 4L16 16" /><path d="m13.5 5-3 14" /></Svg>
export const IInfo = (p: Props) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><path d="M12 7.6h.01" /></Svg>
export const ILogout = (p: Props) => <Svg {...p}><path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14" /><path d="M10 16.5 5.5 12 10 7.5" /><path d="M5.5 12H15" /></Svg>
export const ITrash = (p: Props) => <Svg {...p}><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12" /></Svg>
export const IAdd = (p: Props) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
export const IChevronRight = (p: Props) => <Svg {...p}><path d="m9.5 6 6 6-6 6" /></Svg>
export const IBack = (p: Props) => <Svg {...p}><path d="M20 12H5" /><path d="m11 18-6-6 6-6" /></Svg>
export const IClose = (p: Props) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>
export const ICheck = (p: Props) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>
export const ISearch = (p: Props) => <Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.4-4.4" /></Svg>
export const ILocation = (p: Props) => <Svg {...p}><path d="M12 21s-6.5-5.5-6.5-10.8a6.5 6.5 0 0 1 13 0C18.5 15.5 12 21 12 21z" /><circle cx="12" cy="10.2" r="2.4" /></Svg>
export const IContact = (p: Props) => <Svg {...p}><rect x="3" y="4.5" width="18" height="15" rx="3" /><circle cx="9" cy="10.5" r="2.4" /><path d="M5.5 16.5c.6-1.7 1.9-2.6 3.5-2.6s2.9.9 3.5 2.6" /><path d="M15 10h3.5M15 13.5h3.5" /></Svg>
export const IClock = (p: Props) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>
export const ISchedule = (p: Props) => <Svg {...p}><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /><path d="M12 13v2.5l1.8 1" /></Svg>
export const ISend = (p: Props) => <Svg {...p} fill><path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a1 1 0 0 0-1.4.92V9.5c0 .5.37.93.87.99L14 12 2.87 13.5a1 1 0 0 0-.87 1v4.98a1 1 0 0 0 1.4.92z" /></Svg>
export const ISilent = (p: Props) => <Svg {...p}><path d="M11 5 6.5 9H3.5v6h3L11 19z" /><path d="m16 9 5 6M21 9l-5 6" /></Svg>
export const ISound = (p: Props) => <Svg {...p}><path d="M11 5 6.5 9H3.5v6h3L11 19z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></Svg>
export const IEyeOff = (p: Props) => <Svg {...p}><path d="M3 3l18 18" /><path d="M10.6 5.2A9.8 9.8 0 0 1 12 5c5 0 8.4 4.4 9.4 6-.4.7-1.2 1.9-2.4 3.1" /><path d="M6.6 6.7C4.6 8 3.2 10 2.6 11c1 1.6 4.4 6 9.4 6 1.6 0 3-.4 4.2-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></Svg>
export const IEye = (p: Props) => <Svg {...p}><path d="M2.6 12c1-1.6 4.4-6 9.4-6s8.4 4.4 9.4 6c-1 1.6-4.4 6-9.4 6s-8.4-4.4-9.4-6z" /><circle cx="12" cy="12" r="3" /></Svg>
export const IImage = (p: Props) => <Svg {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><circle cx="9" cy="10" r="1.8" /><path d="m20.5 16-4.5-4.5L7 20" /></Svg>
export const IFile = (p: Props) => <Svg {...p}><path d="M14 2.5H7a2.5 2.5 0 0 0-2.5 2.5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V8z" /><path d="M14 2.5V8h5.5" /></Svg>
export const IPoll = (p: Props) => <Svg {...p}><path d="M6 20v-7M12 20V4M18 20v-5" /></Svg>
export const ICopy = (p: Props) => <Svg {...p}><rect x="8.5" y="8.5" width="12" height="12" rx="2.5" /><path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" /></Svg>
export const IDownload = (p: Props) => <Svg {...p}><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M4.5 19.5h15" /></Svg>
export const IRefresh = (p: Props) => <Svg {...p}><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 20v-4h-4" /></Svg>
export const ILink = (p: Props) => <Svg {...p}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" /></Svg>
export const IGlobe = (p: Props) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></Svg>
export const IMotion = (p: Props) => <Svg {...p}><circle cx="15" cy="12" r="5" /><path d="M3 9h5M2 12h5M3 15h5" /></Svg>
export const ISwap = (p: Props) => <Svg {...p}><path d="M7 4 3.5 7.5 7 11" /><path d="M3.5 7.5H16" /><path d="m17 13 3.5 3.5L17 20" /><path d="M20.5 16.5H8" /></Svg>
export const IMail = (p: Props) => <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></Svg>
export const IWarning = (p: Props) => <Svg {...p}><path d="M12 3.5 2.5 20h19z" /><path d="M12 10v4.5" /><path d="M12 17.3h.01" /></Svg>
export const IMap = (p: Props) => <Svg {...p}><path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6z" /><path d="M9 4v14M15 6v14" /></Svg>
export const IGallery = (p: Props) => <Svg {...p}><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="8" rx="2" /><rect x="3" y="13" width="8" height="8" rx="2" /><rect x="13" y="13" width="8" height="8" rx="2" /></Svg>
export const IMicOff = (p: Props) => <Svg {...p}><path d="M15 10.5V5.5a3 3 0 0 0-5.6-1.5M9 9v1.5a3 3 0 0 0 4.7 2.5" /><path d="M5.5 11a6.5 6.5 0 0 0 10.6 5M18.4 12.6c.07-.5.1-1 .1-1.6" /><path d="M12 17.5V21M8.5 21h7M3 3l18 18" /></Svg>
export const IPhoneCall = (p: Props) => <Svg {...p}><path d="M5 4.5h3.2l1.6 4-2 1.3a10.5 10.5 0 0 0 6.4 6.4l1.3-2 4 1.6V19a1.5 1.5 0 0 1-1.6 1.5A15.5 15.5 0 0 1 3.5 6.1 1.5 1.5 0 0 1 5 4.5z" /></Svg>
export const IScreenShare = (p: Props) => <Svg {...p}><rect x="2.5" y="4" width="19" height="13" rx="2.5" /><path d="M8 21h8M12 17v4M12 13.5v-6M9.5 10l2.5-2.5 2.5 2.5" /></Svg>
export const IMinimize = (p: Props) => <Svg {...p}><path d="M6 15l6-6 6 6" /></Svg>
export const IExpand = (p: Props) => <Svg {...p}><path d="M6 9l6 6 6-6" /></Svg>
export const IMic = (p: Props) => <Svg {...p}><rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0" /><path d="M12 17.5V21M8.5 21h7" /></Svg>
export const IAttach = (p: Props) => <Svg {...p}><path d="M21.4 11 12.3 20.1a5 5 0 0 1-7.1-7.1l9.2-9.2a3.5 3.5 0 0 1 5 5L10 18.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></Svg>
export const IFormat = (p: Props) => <Svg {...p}><path d="M5 6.5V5h14v1.5" /><path d="M12 5v14" /><path d="M9 19h6" /></Svg>
export const ISpoiler = (p: Props) => <Svg {...p}><path d="M4 7h3M10 7h4M17 7h3M4 12h5M12 12h3M18 12h2M4 17h2M9 17h5M17 17h3" /></Svg>
export const IStar = (p: Props) => <Svg {...p}><path d="m12 3.5 2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z" /></Svg>
export const IDesktop = (p: Props) => <Svg {...p}><rect x="2.5" y="4" width="19" height="13" rx="2.5" /><path d="M8 21h8M12 17v4" /></Svg>
export const IQr = (p: Props) => <Svg {...p}><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.2" /><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.2" /><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.2" /><path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM18 14h2.5M14 18v2.5" /></Svg>
export const IUpdate = (p: Props) => <Svg {...p}><path d="M12 3v11" /><path d="m7.5 9.5 4.5 4.5 4.5-4.5" /><path d="M4 16.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-2.5" /></Svg>
export const IFingerprint = (p: Props) => <Svg {...p}><path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 3 .3 5.5 1 7.5" /><path d="M9.5 10.5a2.5 2.5 0 0 1 5 0c0 3.5.4 6.3 1.3 8.5" /><path d="M12 10.5c0 4 .6 7.3 1.8 10" /><path d="M6.5 13.5c0 2.2.4 4.3 1.2 6" /><path d="M4 7.5A9.5 9.5 0 0 1 20 7.5" /></Svg>
export const IChat = (p: Props) => <Svg {...p}><path d="M4.5 6.5a2.5 2.5 0 0 1 2.5-2.5h10a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5h-5.3L7 20v-4a2.5 2.5 0 0 1-2.5-2.5z" /></Svg>
export const IStorage = (p: Props) => <Svg {...p}><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></Svg>
export const IMore = (p: Props) => <Svg {...p}><circle cx="12" cy="5.5" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="12" cy="18.5" r="1.2" /></Svg>
export const IPin = (p: Props) => <Svg {...p}><path d="M9 3.5h6l-1 5 3 3v1.5H7V11.5l3-3z" /><path d="M12 13v7.5" /></Svg>
export const IApple = (p: Props) => <Svg {...p}><path d="M15.5 3.5c-.9.1-2 .7-2.6 1.5-.6.7-1 1.7-.9 2.6 1 0 2-.5 2.6-1.3.6-.7 1-1.7.9-2.8z" /><path d="M17.8 12.6c0-2 1.6-3 1.7-3.1-1-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7a3.9 3.9 0 0 0-3.3 2c-1.4 2.4-.4 6 1 8 .7 1 1.5 2 2.5 2s1.4-.6 2.6-.6 1.5.6 2.6.6 1.7-1 2.4-2c.5-.7.9-1.5 1.1-2.3-1.2-.5-2.1-1.7-2.1-3z" /></Svg>
export const ISettingsGear = (p: Props) => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Svg>
