/**
 * 迭代式 JSON 解析器：递归契约可以配几千层嵌套的样例，
 * 解析路径上不能依赖调用栈。正常情况仍优先走原生 JSON.parse。
 */

interface ParseFrame {
  container: Record<string, unknown> | unknown[];
  kind: 'object' | 'array';
  /**
   * object: start 等待键或闭合；colon 等待冒号；value 等待值；comma 等待逗号/闭合
   * array:  value 等待元素或闭合；comma 等待逗号/闭合
   */
  state: 'start' | 'colon' | 'value' | 'comma';
  pendingKey: string | null;
  /** 刚消费过逗号，此刻闭合即尾随逗号。 */
  afterComma: boolean;
}

export class JsonParseError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} (position ${position})`);
    this.name = 'JsonParseError';
  }
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isDigit(code: number | undefined): boolean {
  return code !== undefined && code >= 0x30 && code <= 0x39;
}

export function parseJsonIterative(text: string): unknown {
  const input = text;
  const len = input.length;
  let pos = 0;

  const skipWs = () => {
    while (pos < len && isWhitespace(input.charCodeAt(pos))) pos++;
  };

  function scanString(): string {
    const start = pos++; // 进入时 pos 指向开引号
    let result = '';
    while (pos < len) {
      const code = input.charCodeAt(pos);
      if (code === 0x22) {
        pos++;
        return result;
      }
      if (code === 0x5c) {
        pos++;
        if (pos >= len) throw new JsonParseError('未结束的转义字符', pos);
        const esc = input[pos++];
        switch (esc) {
          case '"': result += '"'; break;
          case '\\': result += '\\'; break;
          case '/': result += '/'; break;
          case 'b': result += '\b'; break;
          case 'f': result += '\f'; break;
          case 'n': result += '\n'; break;
          case 'r': result += '\r'; break;
          case 't': result += '\t'; break;
          case 'u': {
            if (pos + 4 > len) throw new JsonParseError('非法的 \\u 转义', pos);
            const hex = input.slice(pos, pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new JsonParseError('非法的 \\u 转义', pos);
            result += String.fromCharCode(parseInt(hex, 16));
            pos += 4;
            break;
          }
          default:
            throw new JsonParseError(`非法的转义字符 \\${esc}`, pos - 1);
        }
      } else if (code < 0x20) {
        throw new JsonParseError('字符串中出现未转义的控制字符', pos);
      } else {
        result += input[pos++];
      }
    }
    throw new JsonParseError('未结束的字符串', start);
  }

  function scanKeyword<T extends string>(word: T): unknown {
    if (input.startsWith(word, pos)) {
      pos += word.length;
      if (word === 'true') return true;
      if (word === 'false') return false;
      return null;
    }
    throw new JsonParseError('非法的字面量', pos);
  }

  function scanNumber(): number {
    const start = pos;
    if (input[pos] === '-') pos++;
    if (input[pos] === '0' && isDigit(input.charCodeAt(pos + 1))) {
      throw new JsonParseError('数字不能有前导零', pos);
    }
    while (pos < len && isDigit(input.charCodeAt(pos))) pos++;
    if (input[pos] === '.') {
      pos++;
      while (pos < len && isDigit(input.charCodeAt(pos))) pos++;
    }
    if (input[pos] === 'e' || input[pos] === 'E') {
      pos++;
      if (input[pos] === '+' || input[pos] === '-') pos++;
      while (pos < len && isDigit(input.charCodeAt(pos))) pos++;
    }
    const raw = input.slice(start, pos);
    const value = Number(raw);
    if (raw === '' || Number.isNaN(value)) throw new JsonParseError('非法的数字', start);
    return value;
  }

  /** 读取一个字面量值；遇到容器起始符则压栈并返回 null（由主循环处理）。 */
  function readScalarOrOpen(): {scalar?: unknown; opened?: 'object' | 'array'} {
    const code = input.charCodeAt(pos);
    if (code === 0x22) return {scalar: scanString()};
    if (code === 0x7b) {
      pos++;
      return {opened: 'object'};
    }
    if (code === 0x5b) {
      pos++;
      return {opened: 'array'};
    }
    if (code === 0x74) return {scalar: scanKeyword('true')};
    if (code === 0x66) return {scalar: scanKeyword('false')};
    if (code === 0x6e) return {scalar: scanKeyword('null')};
    if (code === 0x2d || isDigit(code)) return {scalar: scanNumber()};
    throw new JsonParseError('非法的 JSON 值', pos);
  }

  /** 把一个值放进当前 frame 的待填槽位（对象 pendingKey / 数组末尾）。 */
  function placeInFrame(frame: ParseFrame, value: unknown) {
    if (frame.kind === 'object') {
      (frame.container as Record<string, unknown>)[frame.pendingKey as string] = value;
    } else {
      (frame.container as unknown[]).push(value);
    }
  }

  const stack: ParseFrame[] = [];
  let root: unknown = undefined;

  skipWs();
  if (pos >= len) throw new JsonParseError('空输入', pos);

  // 读第一个值
  {
    const first = readScalarOrOpen();
    if (first.opened) {
      const container = first.opened === 'object' ? {} : [];
      root = container;
      stack.push({container, kind: first.opened, state: 'start', pendingKey: null, afterComma: false});
    } else {
      root = first.scalar;
      skipWs();
      if (pos !== len) throw new JsonParseError('根字面量后存在多余字符', pos);
      return root;
    }
  }

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    skipWs();
    if (pos >= len) throw new JsonParseError('意外的输入结束', pos);
    const code = input.charCodeAt(pos);

    if (frame.kind === 'object') {
      if (frame.state === 'start') {
        if (code === 0x7d) {
          if (frame.afterComma) throw new JsonParseError('多余的逗号：对象不应以逗号结束', pos);
          pos++;
          stack.pop();
          continue;
        }
        if (code !== 0x22) throw new JsonParseError('对象键必须是字符串', pos);
        frame.pendingKey = scanString();
        frame.state = 'colon';
        continue;
      }
      if (frame.state === 'colon') {
        if (code !== 0x3a) throw new JsonParseError('对象键后缺少冒号', pos);
        pos++;
        frame.state = 'value';
        continue;
      }
      if (frame.state === 'value') {
        const next = readScalarOrOpen();
        if (next.opened) {
          const container: Record<string, unknown> | unknown[] = next.opened === 'object' ? {} : [];
          placeInFrame(frame, container);
          frame.state = 'comma';
          frame.afterComma = false;
          stack.push({container, kind: next.opened, state: 'start', pendingKey: null, afterComma: false});
        } else {
          placeInFrame(frame, next.scalar);
          frame.state = 'comma';
        }
        continue;
      }
      // comma：期望逗号或闭合
      if (code === 0x7d) {
        pos++;
        stack.pop();
        continue;
      }
      if (code === 0x2c) {
        pos++;
        frame.state = 'start';
        frame.afterComma = true;
        continue;
      }
      throw new JsonParseError('对象成员后应为逗号或闭合花括号', pos);
    }

    // array
    if (frame.state === 'value' || frame.state === 'start') {
      if (code === 0x5d) {
        if (frame.afterComma) throw new JsonParseError('多余的逗号：数组不应以逗号结束', pos);
        pos++;
        stack.pop();
        continue;
      }
      const next = readScalarOrOpen();
      if (next.opened) {
        const container: Record<string, unknown> | unknown[] = next.opened === 'object' ? {} : [];
        placeInFrame(frame, container);
        frame.state = 'comma';
        frame.afterComma = false;
        stack.push({container, kind: next.opened, state: 'start', pendingKey: null, afterComma: false});
      } else {
        placeInFrame(frame, next.scalar);
        frame.state = 'comma';
      }
      continue;
    }
    // comma
    if (code === 0x5d) {
      pos++;
      stack.pop();
      continue;
    }
    if (code === 0x2c) {
      pos++;
      frame.state = 'value';
      frame.afterComma = true;
      continue;
    }
    throw new JsonParseError('数组元素后应为逗号或闭合方括号', pos);
  }

  skipWs();
  if (pos !== len) throw new JsonParseError('根对象后存在多余字符', pos);
  return root;
}

/**
 * 优先使用原生解析器（快）；只有在因嵌套过深抛 RangeError 时
 * 回退到迭代式实现，真正的语法错误依旧正常抛出。
 */
export function parseSample(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof RangeError) {
      return parseJsonIterative(text);
    }
    throw error;
  }
}

/**
 * 迭代式 JSON 序列化：几千层嵌套的样例同样不能在序列化时爆栈。
 * 输出紧凑 JSON（无缩进），只需要能喂给 parseSample。
 */
export function stringifyIterative(value: unknown): string {
  const chunks: string[] = [];
  interface Frame {
    value: unknown;
    stage: 'enter' | 'afterFirst' | 'iterate';
    index: number;
    entries?: Array<[string, unknown]>;
  }
  const stack: Frame[] = [{value, stage: 'enter', index: 0}];

  while (stack.length) {
    const frame = stack[stack.length - 1];

    if (frame.stage === 'enter') {
      const v = frame.value;
      if (v === null) {
        chunks.push('null');
        stack.pop();
      } else if (Array.isArray(v)) {
        chunks.push('[');
        frame.stage = 'afterFirst';
        frame.index = 0;
      } else if (typeof v === 'object') {
        chunks.push('{');
        frame.entries = Object.entries(v as Record<string, unknown>);
        frame.stage = 'afterFirst';
        frame.index = 0;
      } else {
        chunks.push(JSON.stringify(v));
        stack.pop();
      }
      continue;
    }

    const isArray = Array.isArray(frame.value);
    const length = isArray
      ? (frame.value as unknown[]).length
      : (frame.entries?.length ?? 0);

    if (frame.index >= length) {
      chunks.push(isArray ? ']' : '}');
      stack.pop();
      continue;
    }
    if (frame.index > 0) chunks.push(',');

    let childValue: unknown;
    if (isArray) {
      childValue = (frame.value as unknown[])[frame.index];
    } else {
      const [key, val] = frame.entries![frame.index];
      chunks.push(JSON.stringify(key), ':');
      childValue = val;
    }
    frame.index++;
    stack.push({value: childValue, stage: 'enter', index: 0});
  }

  return chunks.join('');
}
