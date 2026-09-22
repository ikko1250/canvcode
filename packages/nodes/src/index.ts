import type { AnyNodeTypeDef } from './defineNodeType.ts'
import { geoType } from './geo.ts'

export * from './defineNodeType.ts'
export * from './geo.ts'

// ビルド時に組み込むノードの型の一覧（MAI-9）
export const builtinNodeTypes: AnyNodeTypeDef[] = [geoType]
