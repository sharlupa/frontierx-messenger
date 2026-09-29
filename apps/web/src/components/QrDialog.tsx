import { useEffect, useMemo, useRef, useState } from "react"
import { useSettings } from "../state/settings"
import { qrMatrix } from "../lib/qr"
import { Button, Sheet } from "./m3"
import { IQr, IDownload, ILink } from "./m3icons"

const LOGO_SVG = "<svg width='66' height='66' viewBox='0 0 66 66' fill='none' xmlns='http://www.w3.org/2000/svg'><g clip-path='url(#qrc0)'><mask id='qrm0' maskUnits='userSpaceOnUse' x='0' y='0' width='66' height='66'><path d='M66 33C66 14.7746 51.2254 0 33 0C14.7746 0 0 14.7746 0 33C0 51.2254 14.7746 66 33 66C51.2254 66 66 51.2254 66 33Z' fill='white'/></mask><g mask='url(#qrm0)'><path d='M66 33C66 14.7746 51.2254 0 33 0C14.7746 0 0 14.7746 0 33C0 51.2254 14.7746 66 33 66C51.2254 66 66 51.2254 66 33Z' fill='#005CFF'/><path d='M25.7426 40.2165C28.2977 42.7717 30.6917 47.0833 32.5104 50.9328C33.7312 53.5165 37.7411 53.417 38.6453 50.7062L48.0108 22.6294C48.9673 19.762 46.2384 17.034 43.3713 17.9913L15.33 27.3542C12.6167 28.2601 12.5214 32.2793 15.1085 33.4998C18.9309 35.3031 23.2004 37.6744 25.7426 40.2165Z' fill='url(#qrp0)' fill-opacity='0.9'/><path d='M14.4606 33.0957C14.6537 33.2513 14.8704 33.3874 15.1091 33.5C18.9314 35.3033 23.2008 37.6748 25.7429 40.2168C28.2978 42.772 30.6918 47.0833 32.5104 50.9326C32.6838 51.2994 32.9154 51.6103 33.1843 51.8691L26.9606 68.9697C24.8541 74.7562 17.2736 76.0932 13.3151 71.376L-5.61163 48.8193C-9.57011 44.1017 -6.93719 36.8682 -0.872373 35.7988L14.4606 33.0957Z' fill='#FA1055'/></g></g><defs><linearGradient id='qrp0' x1='28.6667' y1='15.6667' x2='28.6667' y2='59.0107' gradientUnits='userSpaceOnUse'><stop stop-color='white'/><stop offset='1' stop-color='white' stop-opacity='0.6'/></linearGradient><clipPath id='qrc0'><rect width='66' height='66' fill='white'/></clipPath></defs></svg>"

const LOGO_URL = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(LOGO_SVG)

export function QrDialog({ value, title, onClose }: { value: string; title?: string; onClose: () => void }) {
  const { t } = useSettings()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [copied, setCopied] = useState(false)
  const matrix = useMemo(() => qrMatrix(value, "H"), [value])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const count = matrix.length
    const quiet = 4
    const scale = 10
    const dim = (count + quiet * 2) * scale
    canvas.width = dim
    canvas.height = dim
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, dim, dim)
    ctx.fillStyle = "#000000"
    for (let y = 0; y < count; y++) {
      for (let x = 0; x < count; x++) {
        if (matrix[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale)
      }
    }
    const logo = new Image()
    logo.onload = () => {
      const logoSide = Math.round(dim * 0.2)
      const pad = Math.round(logoSide * 0.16)
      const box = logoSide + pad * 2
      ctx.fillStyle = "#ffffff"
      ctx.beginPath()
      ctx.arc(dim / 2, dim / 2, box / 2, 0, Math.PI * 2)
      ctx.closePath()
      ctx.fill()
      const lx = Math.round((dim - logoSide) / 2)
      ctx.drawImage(logo, lx, lx, logoSide, logoSide)
    }
    logo.src = LOGO_URL
  }, [matrix])

  function download() {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement("a")
    link.href = canvas.toDataURL("image/png")
    link.download = "frontierx-invite.png"
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  async function share() {
    const canvas = canvasRef.current
    const nav = navigator as unknown as {
      share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>
      canShare?: (data: { files?: File[] }) => boolean
    }
    try {
      if (canvas && typeof nav.share === "function") {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
        if (blob) {
          const file = new File([blob], "frontierx-invite.png", { type: "image/png" })
          if (!nav.canShare || nav.canShare({ files: [file] })) {
            await nav.share({ files: [file], title: title || value, text: value })
            return
          }
        }
      }
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }

  return (
    <Sheet title={title || t("qrInviteTitle")} icon={<IQr />} iconShape="cookie12" iconTone="blue" onClose={onClose} size="sm"
      actions={
        <>
          <Button variant="tonal" icon={<ILink size={18} />} onClick={() => void share()}>{copied ? t("inviteCopied") : t("qrShare")}</Button>
          <Button variant="filled" icon={<IDownload size={18} />} onClick={download}>{t("qrDownload")}</Button>
        </>
      }
    >
      <div className="qr-canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
      <p className="qr-hint">{t("qrScanHint")}</p>
    </Sheet>
  )
}
