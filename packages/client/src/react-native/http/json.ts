import type { HttpWorkBudget } from './work-budget.js'

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
interface JsonObject {
  [key: string]: JsonValue
}
type Container =
  | {
      readonly kind: 'array'
      readonly value: JsonValue[]
      state: 'first' | 'value' | 'separator'
    }
  | {
      readonly kind: 'object'
      readonly value: JsonObject
      state: 'first' | 'key' | 'colon' | 'value' | 'separator'
      key: string
    }
type NumberState =
  | 'sign'
  | 'zero'
  | 'integer'
  | 'decimal'
  | 'fraction'
  | 'exponent'
  | 'exponentSign'
  | 'exponentDigits'

function whitespace(character: number): boolean {
  return (
    character === 32 || character === 9 || character === 10 || character === 13
  )
}
function digit(character: number): boolean {
  return character >= 48 && character <= 57
}

/** A resumable grammar parser. No whole-response or whole-token final parse. */
class JsonReader {
  position = 0
  private readonly containers: Container[] = []
  private root: JsonValue = null
  private hasRoot = false
  private token: 'string' | 'number' | undefined
  private stringValue = ''
  private escape = false
  private unicodeRemaining = 0
  private unicodeValue = 0
  private numberState: NumberState = 'sign'
  private numberBeginning = 0
  private negative = false
  private integerDigits = 0
  private leadingZeroDigits = 0
  private significantDigits = ''
  private discardedNonzero = false
  private exponent = 0
  private exponentNegative = false
  private probeWorkUnits = 0
  constructor(private readonly content: string) {}

  private fail(): never {
    throw new SyntaxError(`Invalid JSON at position ${this.position}.`)
  }

  private value(value: JsonValue): void {
    const container = this.containers.at(-1)
    if (!container) {
      if (this.hasRoot) this.fail()
      this.root = value
      this.hasRoot = true
    } else if (container.kind === 'array') {
      if (container.state !== 'first' && container.state !== 'value')
        this.fail()
      container.value.push(value)
      container.state = 'separator'
    } else {
      if (container.state !== 'value') this.fail()
      if (container.key === '__proto__')
        Object.defineProperty(container.value, container.key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        })
      else container.value[container.key] = value
      container.state = 'separator'
    }
  }

  private smallObject(): boolean {
    const beginning = this.position
    const limit = Math.min(beginning + 2048, this.content.length)
    let depth = 0
    let inString = false
    let escaped = false
    for (let position = beginning; position < limit; position += 1) {
      const character = this.content.charCodeAt(position)
      if (inString) {
        if (escaped) escaped = false
        else if (character === 92) escaped = true
        else if (character === 34) inString = false
      } else if (character === 34) inString = true
      else if (character === 123 || character === 91) depth += 1
      else if (character === 125 || character === 93) {
        depth -= 1
        if (depth === 0) {
          // Ordinary records retain the native parser's speed. Its input is
          // strictly bounded, while larger values use the resumable grammar.
          this.value(
            JSON.parse(
              this.content.slice(beginning, position + 1),
            ) as JsonValue,
          )
          this.position = position + 1
          return true
        }
      }
    }
    this.probeWorkUnits += limit - beginning
    return false
  }

  private string(): void {
    let piece = ''
    const limit = Math.min(this.position + 1024, this.content.length)
    let runBeginning = this.position
    while (this.position < limit) {
      const character = this.content.charCodeAt(this.position++)
      if (this.unicodeRemaining) {
        const hexadecimal =
          character >= 48 && character <= 57
            ? character - 48
            : character >= 65 && character <= 70
              ? character - 55
              : character >= 97 && character <= 102
                ? character - 87
                : -1
        if (hexadecimal < 0) this.fail()
        this.unicodeValue = this.unicodeValue * 16 + hexadecimal
        this.unicodeRemaining -= 1
        if (!this.unicodeRemaining)
          piece += String.fromCharCode(this.unicodeValue)
        runBeginning = this.position
      } else if (this.escape) {
        this.escape = false
        if (character === 117) {
          this.unicodeRemaining = 4
          this.unicodeValue = 0
        } else if (character === 34 || character === 47 || character === 92)
          piece += String.fromCharCode(character)
        else if (character === 98) piece += '\b'
        else if (character === 102) piece += '\f'
        else if (character === 110) piece += '\n'
        else if (character === 114) piece += '\r'
        else if (character === 116) piece += '\t'
        else this.fail()
        runBeginning = this.position
      } else if (character === 34 || character === 92) {
        piece += this.content.slice(runBeginning, this.position - 1)
        runBeginning = this.position
        if (character === 92) this.escape = true
        else {
          this.stringValue += piece
          const container = this.containers.at(-1)
          if (
            container?.kind === 'object' &&
            (container.state === 'first' || container.state === 'key')
          ) {
            container.key = this.stringValue
            container.state = 'colon'
          } else this.value(this.stringValue)
          this.stringValue = ''
          this.token = undefined
          return
        }
      } else if (character < 32) this.fail()
    }
    piece += this.content.slice(runBeginning, this.position)
    // Append bounded decoded pieces as they are produced, with no final join.
    this.stringValue += piece
  }

  private coefficient(character: number, integer: boolean): void {
    if (integer) this.integerDigits += 1
    if (!this.significantDigits && character === 48) this.leadingZeroDigits += 1
    else if (this.significantDigits.length < 1200)
      this.significantDigits += String.fromCharCode(character)
    else if (character !== 48) this.discardedNonzero = true
  }

  private exponentDigit(character: number): void {
    // Larger magnitudes cannot be cancelled by any coefficient in this input.
    this.exponent = Math.min(
      this.content.length + 2048,
      this.exponent * 10 + character - 48,
    )
  }

  private finishNumber(): void {
    if (
      !['zero', 'integer', 'fraction', 'exponentDigits'].includes(
        this.numberState,
      )
    )
      this.fail()
    let result: number
    if (this.position - this.numberBeginning <= 2048)
      result = Number(this.content.slice(this.numberBeginning, this.position))
    else if (!this.significantDigits) result = this.negative ? -0 : 0
    else {
      const exponent =
        this.integerDigits -
        this.leadingZeroDigits -
        1 +
        (this.exponentNegative ? -this.exponent : this.exponent)
      // Every binary64 rounding midpoint has fewer than 1200 significant decimal
      // digits. A sticky digit retains the side of a midpoint after truncation.
      const coefficient = `${this.significantDigits[0]}.${this.significantDigits.slice(1)}${this.discardedNonzero ? '1' : ''}`
      result = Number(`${this.negative ? '-' : ''}${coefficient}e${exponent}`)
    }
    this.value(result)
    this.significantDigits = ''
    this.token = undefined
  }

  private number(): void {
    const limit = Math.min(this.position + 1024, this.content.length)
    while (this.position < limit) {
      const character = this.content.charCodeAt(this.position)
      if (this.numberState === 'sign') {
        if (!digit(character)) this.fail()
        this.numberState = character === 48 ? 'zero' : 'integer'
        this.coefficient(character, true)
      } else if (this.numberState === 'integer' && digit(character))
        this.coefficient(character, true)
      else if (
        (this.numberState === 'zero' || this.numberState === 'integer') &&
        character === 46
      )
        this.numberState = 'decimal'
      else if (this.numberState === 'decimal') {
        if (!digit(character)) this.fail()
        this.numberState = 'fraction'
        this.coefficient(character, false)
      } else if (this.numberState === 'fraction' && digit(character))
        this.coefficient(character, false)
      else if (
        ['zero', 'integer', 'fraction'].includes(this.numberState) &&
        (character === 69 || character === 101)
      )
        this.numberState = 'exponent'
      else if (this.numberState === 'exponent') {
        if (character === 43 || character === 45) {
          this.exponentNegative = character === 45
          this.numberState = 'exponentSign'
        } else {
          if (!digit(character)) this.fail()
          this.numberState = 'exponentDigits'
          this.exponentDigit(character)
        }
      } else if (this.numberState === 'exponentSign') {
        if (!digit(character)) this.fail()
        this.numberState = 'exponentDigits'
        this.exponentDigit(character)
      } else if (this.numberState === 'exponentDigits' && digit(character))
        this.exponentDigit(character)
      else {
        this.finishNumber()
        return
      }
      this.position += 1
    }
    if (this.position === this.content.length) this.finishNumber()
  }

  advance(): number {
    const beginning = this.position
    this.probeWorkUnits = 0
    if (this.token === 'string') this.string()
    else if (this.token === 'number') this.number()
    else {
      const limit = Math.min(this.position + 1024, this.content.length)
      while (
        this.position < limit &&
        whitespace(this.content.charCodeAt(this.position))
      )
        this.position += 1
      if (this.position === limit) return Math.max(1, this.position - beginning)
      const character = this.content.charCodeAt(this.position)
      const container = this.containers.at(-1)
      if (container?.kind === 'object' && container.state === 'colon') {
        if (character !== 58) this.fail()
        container.state = 'value'
        this.position += 1
      } else if (container?.state === 'separator') {
        if (character === 44) {
          container.state = container.kind === 'array' ? 'value' : 'key'
          this.position += 1
        } else if (
          (container.kind === 'array' && character === 93) ||
          (container.kind === 'object' && character === 125)
        ) {
          this.containers.pop()
          this.position += 1
        } else this.fail()
      } else if (
        container?.state === 'first' &&
        ((container.kind === 'array' && character === 93) ||
          (container.kind === 'object' && character === 125))
      ) {
        this.containers.pop()
        this.position += 1
      } else {
        const expectsKey =
          container?.kind === 'object' &&
          (container.state === 'first' || container.state === 'key')
        if (expectsKey && character !== 34) this.fail()
        if (!container && this.hasRoot) this.fail()
        if (character === 34) {
          this.token = 'string'
          this.position += 1
          this.string()
        } else if (character === 91 || character === 123) {
          if (
            character === 123 &&
            container?.kind === 'array' &&
            this.smallObject()
          )
            return this.position - beginning
          const value = character === 91 ? [] : {}
          this.value(value)
          this.containers.push(
            character === 91
              ? { kind: 'array', value: value as JsonValue[], state: 'first' }
              : {
                  kind: 'object',
                  value: value as JsonObject,
                  state: 'first',
                  key: '',
                },
          )
          this.position += 1
        } else if (character === 45 || digit(character)) {
          this.token = 'number'
          this.numberBeginning = this.position
          this.negative = character === 45
          this.integerDigits = 0
          this.leadingZeroDigits = 0
          this.significantDigits = ''
          this.discardedNonzero = false
          this.exponent = 0
          this.exponentNegative = false
          this.numberState = 'sign'
          if (this.negative) this.position += 1
          this.number()
        } else {
          const literal =
            character === 116
              ? (['true', true] as const)
              : character === 102
                ? (['false', false] as const)
                : character === 110
                  ? (['null', null] as const)
                  : undefined
          if (!literal || !this.content.startsWith(literal[0], this.position))
            this.fail()
          this.value(literal[1])
          this.position += literal[0].length
        }
      }
    }
    return Math.max(1, this.position - beginning) + this.probeWorkUnits
  }

  finish(): JsonValue {
    if (this.token || this.containers.length || !this.hasRoot) this.fail()
    return this.root
  }
}

export async function decodeHttpJson(
  content: string,
  budget: HttpWorkBudget,
): Promise<unknown> {
  budget.assertActive()
  const reader = new JsonReader(content)
  while (reader.position < content.length) {
    if (budget.shouldYield(reader.advance())) await budget.yield()
  }
  budget.assertActive()
  return reader.finish()
}
