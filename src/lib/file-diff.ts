import type { GeneratedFile } from "./events";

/** 返回这一轮真正新增、修改或删除的路径，而不是把最终文件树冒充成改动清单。 */
export function changedFilePaths(before: GeneratedFile[], after: GeneratedFile[]): string[] {
  const previous = new Map(before.map((file) => [file.path, file.content]));
  const current = new Map(after.map((file) => [file.path, file.content]));
  const changed = new Set<string>();

  for (const [path, content] of current) {
    if (previous.get(path) !== content) changed.add(path);
  }
  for (const path of previous.keys()) {
    if (!current.has(path)) changed.add(path);
  }
  return [...changed].sort();
}
