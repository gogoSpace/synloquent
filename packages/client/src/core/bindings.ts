import type { ModelBinding } from './query.js'
import type {
  FieldDefinition,
  Manifest,
  ModelDefinition,
  WireValue,
} from './types.js'

type FieldValue<Field extends FieldDefinition> = Field['type'] extends 'boolean'
  ? boolean
  : Field['type'] extends 'integer'
    ? number | string
    : Field['type'] extends 'float'
      ? number
      : Field['type'] extends 'json'
        ? WireValue
        : Field['type'] extends 'enum'
          ? Field extends {
              readonly enum: readonly (infer Value extends string)[]
            }
            ? Value
            : string
          : string

type NullableFieldValue<Field extends FieldDefinition> =
  Field['nullable'] extends true ? FieldValue<Field> | null : FieldValue<Field>
export type ReadableAttributes<Definition extends ModelDefinition> = {
  [
    Field in keyof Definition['fields'] as Definition['fields'][Field]['readable'] extends true
      ? Field
      : never
  ]: Definition['fields'][Field] extends { readonly materialized: true }
    ? NullableFieldValue<Definition['fields'][Field]> | undefined
    : NullableFieldValue<Definition['fields'][Field]>
}
export type WritableAttributes<Definition extends ModelDefinition> = {
  [
    Field in keyof Definition['fields'] as Definition['fields'][Field]['writable'] extends true
      ? Field
      : never
  ]: NullableFieldValue<Definition['fields'][Field]>
}
export type BindSchema<Schema extends Manifest> = {
  [Name in keyof Schema['models']]: ModelBinding<
    ReadableAttributes<Schema['models'][Name]>,
    WritableAttributes<Schema['models'][Name]>,
    keyof Schema['models'][Name]['relations'] & string
  >
}

type DeclaredFields<Fields extends Readonly<Record<string, FieldDefinition>>> =
  { [Field in keyof Fields]: NullableFieldValue<Fields[Field]> }
export type BindCommands<Schema extends Manifest> = Schema extends {
  readonly commands: infer Commands extends NonNullable<Manifest['commands']>
}
  ? {
      [Name in keyof Commands]: (
        arguments_: DeclaredFields<Commands[Name]['arguments']>,
        operationId: string,
      ) => Promise<DeclaredFields<Commands[Name]['result']>>
    }
  : Record<string, never>
export type BindScopes<Schema extends Manifest> = Schema extends {
  readonly scopes: infer Scopes extends NonNullable<Manifest['scopes']>
}
  ? {
      [Name in keyof Scopes]: (
        arguments_: DeclaredFields<Scopes[Name]['arguments']>,
      ) => import('./query.js').Query<
        ReadableAttributes<Schema['models'][Scopes[Name]['model']]>,
        WritableAttributes<Schema['models'][Scopes[Name]['model']]>,
        keyof Schema['models'][Scopes[Name]['model']]['relations'] & string,
        undefined,
        'remote'
      >
    }
  : Record<string, never>

type OperationIdentity = {
  readonly operationId: string
  readonly localIdentity: string
  readonly id?: string
  readonly expectedRevision?: string
  readonly dependsOn: readonly string[]
  readonly atomicGroup?: string
  readonly eventMode?: 'instance' | 'bulk'
}
type WritableNumbers<Definition extends ModelDefinition> = {
  [
    Field in keyof Definition['fields']
  ]: Definition['fields'][Field]['writable'] extends true
    ? Definition['fields'][Field]['type'] extends 'integer' | 'float'
      ? Field
      : never
    : never
}[keyof Definition['fields']] &
  string
type PivotNames<Definition extends ModelDefinition> = {
  [
    Name in keyof Definition['relations']
  ]: Definition['relations'][Name] extends { readonly pivot: object }
    ? Name
    : never
}[keyof Definition['relations']] &
  string
export type BindOperations<Schema extends Manifest> = {
  [Name in keyof Schema['models'] & string]: OperationIdentity & {
    readonly model: Name
  } & (
      | {
          readonly action: 'create' | 'update'
          readonly values: Partial<WritableAttributes<Schema['models'][Name]>>
        }
      | {
          readonly action: 'delete' | 'restore' | 'forceDelete'
          readonly values: Readonly<Record<string, never>>
        }
      | {
          readonly action: 'increment'
          readonly values: {
            readonly field: WritableNumbers<Schema['models'][Name]>
            readonly delta: number
          }
        }
      | {
          readonly action: 'pivot'
          readonly values: {
            readonly relation: PivotNames<Schema['models'][Name]>
            readonly action:
              | 'attach'
              | 'detach'
              | 'toggle'
              | 'updateExistingPivot'
              | 'sync'
              | 'syncWithoutDetaching'
            readonly targets: readonly WireValue[]
            readonly attributes?: Readonly<Record<string, WireValue>>
            readonly expectedRelationRevision?: string
            readonly completeSet?: boolean
          }
        }
    )
}[keyof Schema['models'] & string]
