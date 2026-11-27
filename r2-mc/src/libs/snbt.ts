// R2Link 传输 neomega-nbt 的 SNBT。外观处理器读取 JS 值，查看面板保留 SNBT 原文。
type NumericArray = Int8Array | Int32Array | BigInt64Array;
type ArrayKind = "B" | "I" | "L";
export type Tag = string | number | bigint | boolean | NumericArray | Tag[] | Compound;
export interface Compound {
  [key: string]: Tag;
}

export function isCompound(tag: unknown): tag is Compound {
  return typeof tag === "object" && tag !== null && !Array.isArray(tag) && !ArrayBuffer.isView(tag);
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

// Go 的未加引号字符串允许非 ASCII 字符。结构标点只在引号外有意义。
function isBareChar(char: string): boolean {
  return (
    isDigit(char) ||
    (char >= "A" && char <= "Z") ||
    (char >= "a" && char <= "z") ||
    char === "_" ||
    char === "." ||
    char === "+" ||
    char === "-" ||
    char.charCodeAt(0) >= 128
  );
}

const escapes = new Map(
  Object.entries({
    '"': '"',
    "'": "'",
    "\\": "\\",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    s: " ",
    t: "\t",
  }),
);

/** 识别完整的十进制词，包括小数和指数。含有其他字符的裸词仍是字符串。 */
function decimalForm(word: string): "integer" | "float" | undefined {
  let i = word[0] === "+" || word[0] === "-" ? 1 : 0;
  const start = i;
  while (i < word.length && isDigit(word[i])) i++;
  const whole = i > start;
  const point = word[i] === ".";
  if (point) {
    const fraction = ++i;
    while (i < word.length && isDigit(word[i])) i++;
    if (!whole && i === fraction) return;
  } else if (!whole) return;

  const exponent = word[i] === "e" || word[i] === "E";
  if (exponent) {
    i++;
    if (word[i] === "+" || word[i] === "-") i++;
    const digits = i;
    while (i < word.length && isDigit(word[i])) i++;
    if (i === digits) return;
  }
  if (i === word.length) return point || exponent ? "float" : "integer";
}

const integerLimits = { b: 128, s: 32768, i: 2147483648 } as const;

/** 数组由表头指定元素类型，Go 写出的数组元素没有后缀。Long 必须从原始十进制串直接读取。 */
function scalar(word: string, offset: number, array: "L"): bigint;
function scalar(word: string, offset: number, array: "B" | "I"): number;
function scalar(word: string, offset: number): string | number | bigint | boolean;
function scalar(word: string, offset: number, array?: ArrayKind): string | number | bigint | boolean {
  const lower = word.toLowerCase();
  if (lower === "true" || lower === "false") {
    const value = lower === "true";
    if (!array) return value;
    return array === "L" ? BigInt(value) : Number(value);
  }

  const last = lower[lower.length - 1];
  const suffix = "bsilfd".includes(last) ? last : "";
  let digits = suffix ? lower.slice(0, -1) : lower;
  if (!array && (suffix === "f" || suffix === "d")) {
    // strconv.FormatFloat 对非有限值使用 NaN、+Inf、-Inf。
    if (digits === "nan") return NaN;
    if (digits === "+inf") return Infinity;
    if (digits === "-inf") return -Infinity;
  }
  if (digits.includes("_")) {
    // 数字间可以使用分隔符；保留诸如 1_item 的整词。
    for (let i = 0; i < digits.length; i++) {
      if (
        digits[i] === "_" &&
        !(i > 0 && i + 1 < digits.length && isDigit(digits[i - 1]) && isDigit(digits[i + 1]))
      ) {
        if (array) throw new SyntaxError(`SNBT 第 ${offset + 1} 字符处的数组元素不是整数`);
        return word;
      }
    }
    digits = digits.replaceAll("_", "");
  }
  const form = decimalForm(digits);
  const type = suffix || array?.toLowerCase() || (form === "float" ? "d" : "i");
  if (array && (form !== "integer" || type !== array.toLowerCase())) {
    throw new SyntaxError(`SNBT 第 ${offset + 1} 字符处应为 ${array} 数组的整数元素`);
  }
  if (!form || (form === "float" && type !== "d" && type !== "f")) return word;
  if (type === "d") return Number(digits);
  if (type === "f") return Math.fround(Number(digits));
  if (type === "l") {
    const value = BigInt(digits);
    if (value >= -(1n << 63n) && value < 1n << 63n) return value;
  } else {
    const value = Number(digits);
    const limit = integerLimits[type as keyof typeof integerLimits];
    if (value >= -limit && value < limit) return value === 0 ? 0 : value;
  }
  throw new SyntaxError(`SNBT 第 ${offset + 1} 字符处的整数超出 ${type.toUpperCase()} 范围`);
}

/** 从一个完整的 SNBT 值读取方块数据。字节、整型、长整型数组保留各自的 JS 类型。 */
export function parseSNBT(text: string): Tag {
  let at = 0;
  function skipSpace(): void {
    while (at < text.length && " \t\n\r\v\f".includes(text[at])) at++;
  }
  function take(char: string): boolean {
    skipSpace();
    if (text[at] !== char) return false;
    at++;
    return true;
  }
  function expect(char: string): void {
    if (!take(char)) throw new SyntaxError(`SNBT 第 ${at + 1} 字符应为 ${char}`);
  }
  function bare(): string {
    const start = at;
    while (at < text.length && isBareChar(text[at])) at++;
    if (at === start) throw new SyntaxError(`SNBT 第 ${at + 1} 字符缺少裸词`);
    return text.slice(start, at);
  }
  function quoted(): string {
    const quote = text[at++];
    let chunk = at;
    let value = "";
    while (at < text.length) {
      const char = text[at++];
      if (char === quote) return value + text.slice(chunk, at - 1);
      if (char === "\\") {
        const decoded = escapes.get(text[at]);
        if (decoded === undefined) throw new SyntaxError(`SNBT 第 ${at} 字符处的转义无效`);
        value += text.slice(chunk, at - 1) + decoded;
        chunk = ++at;
      }
    }
    throw new SyntaxError(`SNBT 第 ${at + 1} 字符缺少结束引号 ${quote}`);
  }

  // 复合标签、列表、数值数组共享分隔规则，包括 Go 读取器允许的末尾逗号。
  function entries(end: string, readEntry: () => void): void {
    while (!take(end)) {
      readEntry();
      if (take(end)) return;
      expect(",");
    }
  }
  function readValue(): Tag {
    skipSpace();
    switch (text[at]) {
      case "{": {
        at++;
        const result: Compound = Object.create(null);
        entries("}", () => {
          const key = text[at] === '"' || text[at] === "'" ? quoted() : bare();
          expect(":");
          result[key] = readValue();
        });
        return result;
      }
      case "[": {
        at++;
        skipSpace();
        const kind = text[at]?.toUpperCase();
        if ((kind === "B" || kind === "I" || kind === "L") && text[at + 1] === ";") {
          at += 2;
          if (kind === "L") {
            const values: bigint[] = [];
            entries("]", () => {
              const start = at;
              values.push(scalar(bare(), start, kind));
            });
            return BigInt64Array.from(values);
          }
          const values: number[] = [];
          entries("]", () => {
            const start = at;
            values.push(scalar(bare(), start, kind));
          });
          return kind === "B" ? Int8Array.from(values) : Int32Array.from(values);
        }
        const list: Tag[] = [];
        entries("]", () => list.push(readValue()));
        return list;
      }
      case '"':
      case "'":
        return quoted();
      default: {
        const start = at;
        return scalar(bare(), start);
      }
    }
  }

  const root = readValue();
  skipSpace();
  if (at !== text.length) throw new SyntaxError(`SNBT 第 ${at + 1} 字符之后还有内容`);
  return root;
}
