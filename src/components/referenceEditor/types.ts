export type ReferenceEditorSaveMode = 'replace-input' | 'append-input'

export interface ReferenceImageEditorModalProps {
  imageId: string
  src: string
  saveMode: ReferenceEditorSaveMode
  onClose: () => void
  onSaved?: (nextImageId: string, nextDataUrl: string) => void
}

export type ToolMode = 'select' | 'mask-brush'
export type MaskShapeType = 'rect' | 'ellipse' | 'triangle'

export interface TextStyleState {
  text: string
  fill: string
  fontSize: number
  fontWeight: 'normal' | 'bold'
  fontStyle: 'normal' | 'italic'
}

export interface BaseImageData {
  editorKind: 'base-image'
  flipX: boolean
  flipY: boolean
}

export const DEFAULT_TEXT_STYLE: TextStyleState = {
  text: '输入文字',
  fill: '#ffffff',
  fontSize: 48,
  fontWeight: 'bold',
  fontStyle: 'normal',
}

export const DEFAULT_MASK_HUE = 0
