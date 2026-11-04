/** `**` (any number of segments), `*` (within one segment), literal text. Same grammar as n8n's
 * .github/scripts/glob.mjs, so a path is a test file here exactly when it is one in n8n's CI. */
const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let source = "";
  const segments = pattern.split("/");
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === "**") {
      source += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    source += segment
      .split("*")
      .map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    if (!last) source += "/";
  });
  const re = new RegExp(`^${source}$`);
  cache.set(pattern, re);
  return re;
}

export const matchesGlob = (path: string, pattern: string): boolean => globToRegExp(pattern).test(path);

export const TEST_PATTERNS = [
  "**/*.test.ts",
  "**/*.test.js",
  "**/*.test.mjs",
  "**/*.spec.ts",
  "**/*.spec.js",
  "**/*.spec.mjs",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/__snapshots__/**",
  "**/*.snap",
  "**/fixtures/**",
  "**/__mocks__/**",
  "packages/quality/policy/**",
  "packages/quality/testing/**",
  "packages/quality/environments/**",
  "packages/quality/efficiency/microbenchmarks/**",
];

export const isTestFile = (path: string): boolean => TEST_PATTERNS.some((p) => matchesGlob(path, p));
