export class Collection<Value> implements Iterable<Value> {
  readonly items: readonly Value[]
  constructor(
    items: readonly Value[] = [],
    readonly completeness: 'complete' | 'partial' | undefined = undefined,
  ) {
    this.items = Object.freeze([...items])
  }
  [Symbol.iterator](): Iterator<Value> {
    return this.items[Symbol.iterator]()
  }
  get length(): number {
    return this.items.length
  }
  all(): Value[] {
    return [...this.items]
  }
  first(): Value | undefined {
    return this.items[0]
  }
  last(): Value | undefined {
    return this.items[this.items.length - 1]
  }
  map<Result>(
    callback: (value: Value, index: number) => Result,
  ): Collection<Result> {
    return new Collection(this.items.map(callback), this.completeness)
  }
  filter(
    predicate: (value: Value, index: number) => boolean,
  ): Collection<Value> {
    return new Collection(this.items.filter(predicate), this.completeness)
  }
  reject(
    predicate: (value: Value, index: number) => boolean,
  ): Collection<Value> {
    return this.filter((value, index) => !predicate(value, index))
  }
  pluck<Key extends keyof Value>(key: Key): Collection<Value[Key]> {
    return this.map((value) => value[key])
  }
  keyBy<Key>(
    callback: keyof Value | ((value: Value) => Key),
  ): Map<Key | Value[keyof Value], Value> {
    return new Map(
      this.items.map((value) => [
        typeof callback === 'function' ? callback(value) : value[callback],
        value,
      ]),
    )
  }
  groupBy<Key>(
    callback: keyof Value | ((value: Value) => Key),
  ): Map<Key | Value[keyof Value], Collection<Value>> {
    const grouped = new Map<Key | Value[keyof Value], Value[]>()
    for (const value of this.items) {
      const key =
        typeof callback === 'function' ? callback(value) : value[callback]
      const group = grouped.get(key) ?? []
      group.push(value)
      grouped.set(key, group)
    }
    return new Map(
      [...grouped].map(([key, values]) => [key, new Collection(values)]),
    )
  }
  sort(compare?: (left: Value, right: Value) => number): Collection<Value> {
    return new Collection([...this.items].sort(compare))
  }
  unique<Key>(
    callback?: keyof Value | ((value: Value) => Key),
  ): Collection<Value> {
    const seen = new Set<unknown>()
    return this.filter((value) => {
      const key =
        callback === undefined
          ? value
          : typeof callback === 'function'
            ? callback(value)
            : value[callback]
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  chunk(size: number): Collection<Collection<Value>> {
    if (!Number.isSafeInteger(size) || size < 1)
      throw new RangeError('Chunk size must be a positive integer.')
    const chunks: Collection<Value>[] = []
    for (let index = 0; index < this.items.length; index += size)
      chunks.push(new Collection(this.items.slice(index, index + size)))
    return new Collection(chunks)
  }
  toJSON(): readonly Value[] {
    return this.items
  }
}
