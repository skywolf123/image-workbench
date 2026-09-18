import type { FabricObject } from 'fabric'
import type { BaseImageData, MaskShapeType } from './types'

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function buildMaskColor(hue: number, alpha: number) {
  return `hsla(${Math.round(hue)}, 85%, 48%, ${clamp(alpha, 0.05, 1)})`
}

export function getEditorKind(object: FabricObject | null): string | undefined {
  if (!object) return undefined
  return (object as FabricObject & { data?: { editorKind?: string } }).data?.editorKind
}

export function isBaseImage(object: FabricObject | null): boolean {
  return getEditorKind(object) === 'base-image'
}

export function getBaseImageData(object: FabricObject | null): BaseImageData | undefined {
  if (!isBaseImage(object)) return undefined
  return (object as FabricObject & { data?: BaseImageData }).data
}

export function getMaskShapeTypeFromObject(object: FabricObject | null): MaskShapeType | undefined {
  if (!object) return undefined
  return (object as FabricObject & { data?: { shapeType?: MaskShapeType } }).data?.shapeType
}

export async function loadHtmlImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = src
  })
}

export async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

export function normalizeColorValue(value: string) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  if (/^#[0-9a-f]{3}$/i.test(value)) return value
  return '#ffffff'
}
