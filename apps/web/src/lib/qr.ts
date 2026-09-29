// Dependency-free QR Code encoder (byte mode).
// Ported from Nayuki's reference QR Code generator (MIT License):
// https://www.nayuki.io/page/qr-code-generator-library
// Supports ECC levels L/M/Q/H, automatic version selection (1..40) and
// optimal mask selection. Pure logic (no DOM), returns a boolean matrix.

export type Ecl = "L" | "M" | "Q" | "H"

const ECC_ORDINAL: Record<Ecl, number> = { L: 0, M: 1, Q: 2, H: 3 }
const ECC_FORMAT_BITS: Record<Ecl, number> = { L: 1, M: 0, Q: 3, H: 2 }

const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]

const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

const PENALTY_N1 = 3
const PENALTY_N2 = 3
const PENALTY_N3 = 40
const PENALTY_N4 = 10

function getNumRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function getNumDataCodewords(ver: number, ecl: number): number {
  return Math.floor(getNumRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver]
}

function reedSolomonMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function reedSolomonComputeDivisor(degree: number): number[] {
  const result: number[] = []
  for (let i = 0; i < degree - 1; i++) result.push(0)
  result.push(1)
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = reedSolomonMultiply(root, 0x02)
  }
  return result
}

function reedSolomonComputeRemainder(data: number[], divisor: number[]): number[] {
  const result: number[] = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    for (let i = 0; i < divisor.length; i++) result[i] ^= reedSolomonMultiply(divisor[i], factor)
  }
  return result
}

function appendBits(val: number, len: number, bb: number[]): void {
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1)
}

function numCharCountBits(ver: number): number {
  return ver <= 9 ? 8 : 16
}

function toUtf8Bytes(str: string): number[] {
  const out: number[] = []
  const encoded = encodeURI(str)
  for (let i = 0; i < encoded.length; i++) {
    if (encoded.charAt(i) === "%") {
      out.push(parseInt(encoded.substr(i + 1, 2), 16))
      i += 2
    } else {
      out.push(encoded.charCodeAt(i))
    }
  }
  return out
}

class QrEncoder {
  readonly size: number
  readonly modules: boolean[][]
  private readonly isFunction: boolean[][]

  constructor(private readonly version: number, private readonly ecl: number, private readonly formatBits: number, dataCodewords: number[]) {
    this.size = version * 4 + 17
    this.modules = []
    this.isFunction = []
    for (let i = 0; i < this.size; i++) {
      const row: boolean[] = []
      const fun: boolean[] = []
      for (let j = 0; j < this.size; j++) {
        row.push(false)
        fun.push(false)
      }
      this.modules.push(row)
      this.isFunction.push(fun)
    }
    this.drawFunctionPatterns()
    const allCodewords = this.addEccAndInterleave(dataCodewords)
    this.drawCodewords(allCodewords)
    let chosen = 0
    let minPenalty = Infinity
    for (let i = 0; i < 8; i++) {
      this.applyMask(i)
      this.drawFormatBits(i)
      const penalty = this.getPenaltyScore()
      if (penalty < minPenalty) {
        chosen = i
        minPenalty = penalty
      }
      this.applyMask(i)
    }
    this.applyMask(chosen)
    this.drawFormatBits(chosen)
  }

  private setFunctionModule(x: number, y: number, isDark: boolean): void {
    this.modules[y][x] = isDark
    this.isFunction[y][x] = true
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0)
      this.setFunctionModule(i, 6, i % 2 === 0)
    }
    this.drawFinderPattern(3, 3)
    this.drawFinderPattern(this.size - 4, 3)
    this.drawFinderPattern(3, this.size - 4)
    const pos = this.getAlignmentPatternPositions()
    const n = pos.length
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) {
          this.drawAlignmentPattern(pos[i], pos[j])
        }
      }
    }
    this.drawFormatBits(0)
    this.drawVersion()
  }

  private drawFormatBits(mask: number): void {
    const data = (this.formatBits << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, ((bits >>> i) & 1) !== 0)
    this.setFunctionModule(8, 7, ((bits >>> 6) & 1) !== 0)
    this.setFunctionModule(8, 8, ((bits >>> 7) & 1) !== 0)
    this.setFunctionModule(7, 8, ((bits >>> 8) & 1) !== 0)
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, ((bits >>> i) & 1) !== 0)
    for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, ((bits >>> i) & 1) !== 0)
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, ((bits >>> i) & 1) !== 0)
    this.setFunctionModule(8, this.size - 8, true)
  }

  private drawVersion(): void {
    if (this.version < 7) return
    let rem = this.version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunctionModule(a, b, bit)
      this.setFunctionModule(b, a, bit)
    }
  }

  private drawFinderPattern(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4)
        }
      }
    }
  }

  private drawAlignmentPattern(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  private getAlignmentPatternPositions(): number[] {
    if (this.version === 1) return []
    const num = Math.floor(this.version / 7) + 2
    const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (num * 2 - 2)) * 2
    const result: number[] = [6]
    for (let p = this.size - 7; result.length < num; p -= step) result.splice(1, 0, p)
    return result
  }

  private addEccAndInterleave(data: number[]): number[] {
    const ver = this.version
    const ecl = this.ecl
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver]
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver]
    const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8)
    const numShort = numBlocks - (rawCodewords % numBlocks)
    const shortLen = Math.floor(rawCodewords / numBlocks)
    const blocks: number[][] = []
    const rsDiv = reedSolomonComputeDivisor(blockEccLen)
    let k = 0
    for (let i = 0; i < numBlocks; i++) {
      const datLen = shortLen - blockEccLen + (i < numShort ? 0 : 1)
      const dat = data.slice(k, k + datLen)
      k += datLen
      const ecc = reedSolomonComputeRemainder(dat, rsDiv)
      if (i < numShort) dat.push(0)
      blocks.push(dat.concat(ecc))
    }
    const result: number[] = []
    for (let i = 0; i < blocks[0].length; i++) {
      for (let j = 0; j < blocks.length; j++) {
        if (i !== shortLen - blockEccLen || j >= numShort) result.push(blocks[j][i])
      }
    }
    return result
  }

  private drawCodewords(data: number[]): void {
    let i = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vert : vert
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0
            i++
          }
        }
      }
    }
  }

  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y][x]) continue
        let invert = false
        if (mask === 0) invert = (x + y) % 2 === 0
        else if (mask === 1) invert = y % 2 === 0
        else if (mask === 2) invert = x % 3 === 0
        else if (mask === 3) invert = (x + y) % 3 === 0
        else if (mask === 4) invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
        else if (mask === 5) invert = ((x * y) % 2) + ((x * y) % 3) === 0
        else if (mask === 6) invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
        else if (mask === 7) invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
        if (invert) this.modules[y][x] = !this.modules[y][x]
      }
    }
  }

  private getPenaltyScore(): number {
    let result = 0
    const size = this.size
    const m = this.modules
    for (let y = 0; y < size; y++) {
      let runColor = false
      let runLen = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let x = 0; x < size; x++) {
        if (m[y][x] === runColor) {
          runLen++
          if (runLen === 5) result += PENALTY_N1
          else if (runLen > 5) result++
        } else {
          this.addHistory(runLen, history)
          if (!runColor) result += this.countPatterns(history) * PENALTY_N3
          runColor = m[y][x]
          runLen = 1
        }
      }
      result += this.terminateAndCount(runColor, runLen, history) * PENALTY_N3
    }
    for (let x = 0; x < size; x++) {
      let runColor = false
      let runLen = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let y = 0; y < size; y++) {
        if (m[y][x] === runColor) {
          runLen++
          if (runLen === 5) result += PENALTY_N1
          else if (runLen > 5) result++
        } else {
          this.addHistory(runLen, history)
          if (!runColor) result += this.countPatterns(history) * PENALTY_N3
          runColor = m[y][x]
          runLen = 1
        }
      }
      result += this.terminateAndCount(runColor, runLen, history) * PENALTY_N3
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x]
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += PENALTY_N2
      }
    }
    let dark = 0
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x]) dark++
    const total = size * size
    const kk = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
    result += kk * PENALTY_N4
    return result
  }

  private countPatterns(history: number[]): number {
    const n = history[1]
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
  }

  private terminateAndCount(runColor: boolean, runLen: number, history: number[]): number {
    let len = runLen
    if (runColor) {
      this.addHistory(len, history)
      len = 0
    }
    len += this.size
    this.addHistory(len, history)
    return this.countPatterns(history)
  }

  private addHistory(runLen: number, history: number[]): void {
    let len = runLen
    if (history[0] === 0) len += this.size
    history.pop()
    history.unshift(len)
  }
}

export function qrMatrix(text: string, ecl: Ecl = "M"): boolean[][] {
  const eclOrd = ECC_ORDINAL[ecl]
  const data = toUtf8Bytes(text)
  let version = -1
  for (let v = 1; v <= 40; v++) {
    const capacityBits = getNumDataCodewords(v, eclOrd) * 8
    const usedBits = 4 + numCharCountBits(v) + data.length * 8
    if (usedBits <= capacityBits) {
      version = v
      break
    }
  }
  if (version === -1) throw new Error("Data too long for QR code")
  const bb: number[] = []
  appendBits(0x4, 4, bb)
  appendBits(data.length, numCharCountBits(version), bb)
  for (const b of data) appendBits(b, 8, bb)
  const capacityBits = getNumDataCodewords(version, eclOrd) * 8
  appendBits(0, Math.min(4, capacityBits - bb.length), bb)
  appendBits(0, (8 - (bb.length % 8)) % 8, bb)
  for (let pad = 0xec; bb.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(pad, 8, bb)
  const dataCodewords: number[] = []
  for (let i = 0; i < bb.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb[i + j]
    dataCodewords.push(byte)
  }
  const enc = new QrEncoder(version, eclOrd, ECC_FORMAT_BITS[ecl], dataCodewords)
  return enc.modules
}