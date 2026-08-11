// =============================================
// path-glob：受限 URL path 匹配
// 只允许 /、字母数字、-_.、单段 * 与多段 **；字符集由 validator 保证。
// =============================================

/** 把受限 path-glob 编译为正则。调用前必须已通过 PATH_GLOB_PATTERN 校验。 */
export function compilePathGlob(glob: string): RegExp {
  const escaped = glob
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}
