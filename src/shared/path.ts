/** 把路径段渲染成 JSONPath 风格的字符串，例如 $.shipping.lines[0].sku */
export function renderJsonPath(path: (string | number)[]): string {
  let out = '$';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      out += `.${segment}`;
    } else {
      out += `[${JSON.stringify(segment)}]`;
    }
  }
  return out;
}
