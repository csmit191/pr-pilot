// Built-in defaults. Kept free of imports from other risk modules so nothing can form a cycle.

const SENSITIVE_NAMES = [
  "auth",
  "authn",
  "authz",
  "authentication",
  "authorization",
  "security",
  "crypto",
  "payment",
  "payments",
  "billing",
  "checkout",
];

/** A directory with that name anywhere in the tree, or a file named e.g. auth.ts. */
export const DEFAULT_SENSITIVE_PATHS: string[] = SENSITIVE_NAMES.flatMap((name) => [
  `**/${name}/**`,
  `**/${name}.*`,
]);

export const DEFAULT_TEST_PATTERNS: string[] = [
  "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs}",
  "**/{__tests__,test,tests}/**",
  "**/*_test.{go,py,rb}",
  "**/test_*.py",
  "**/*_spec.rb",
  "**/*{Test,Tests}.{java,kt,cs}",
];

export const DEFAULT_MIGRATION_PATTERNS: string[] = [
  "**/migrations/**",
  "**/migrate/**",
  "**/alembic/versions/**",
  "**/V[0-9]*__*.sql", // Flyway
  "**/schema.prisma",
];

export const MANIFEST_PATTERNS: string[] = [
  "**/package.json",
  "**/requirements*.txt",
  "**/Pipfile",
  "**/pyproject.toml",
  "**/go.mod",
  "**/Cargo.toml",
  "**/Gemfile",
  "**/pom.xml",
  "**/build.gradle",
  "**/build.gradle.kts",
  "**/composer.json",
  "**/*.csproj",
];

export const LOCKFILE_PATTERNS: string[] = [
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/Pipfile.lock",
  "**/poetry.lock",
  "**/uv.lock",
  "**/go.sum",
  "**/Cargo.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/packages.lock.json",
];

/**
 * Never entropy/pattern-scanned: full of hashes and generated blobs that look like secrets.
 * Not user-configurable on purpose, so a custom config can't accidentally flood reviews.
 */
export const SECRET_SCAN_SKIP: string[] = [
  ...LOCKFILE_PATTERNS,
  "**/*.lock",
  "**/*.snap",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
];
