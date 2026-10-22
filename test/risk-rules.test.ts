import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/risk/config.js";
import { scanDeletedTests } from "../src/risk/rules/deletedTests.js";
import { isLockfile, scanDependencies } from "../src/risk/rules/dependencies.js";
import { scanSize } from "../src/risk/rules/largeDiff.js";
import { scanMigrations } from "../src/risk/rules/migrations.js";
import { scanSensitivePaths } from "../src/risk/rules/sensitivePaths.js";
import { addedPatch, makeFile } from "./helpers.js";

const { rules } = DEFAULT_CONFIG;

describe("scanSensitivePaths", () => {
  it.each([
    "src/auth/login.ts",
    "auth/index.ts",
    "app/payments/stripe.ts",
    "billing/invoice.py",
    "src/security/csrf.ts",
    "lib/auth.rb",
    "src/checkout.tsx",
    "packages/api/crypto/aes.go",
  ])("flags %s", (path) => {
    const flags = scanSensitivePaths([makeFile({ path })], rules.sensitivePaths);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ rule: "sensitivePaths", severity: "high", file: path });
    expect(flags[0]?.reason).toContain("security-sensitive");
  });

  it.each(["src/author/profile.ts", "docs/README.md", "src/authors.ts", "src/utils/format.ts", "notes/oauth-notes.md"])(
    "ignores %s",
    (path) => {
      expect(scanSensitivePaths([makeFile({ path })], rules.sensitivePaths)).toEqual([]);
    },
  );

  it("names the matching pattern in the reason", () => {
    const [flag] = scanSensitivePaths([makeFile({ path: "src/auth/login.ts" })], rules.sensitivePaths);
    expect(flag?.reason).toContain("**/auth/**");
  });

  it("emits one flag per file even when several patterns match", () => {
    const flags = scanSensitivePaths([makeFile({ path: "src/auth/auth.ts" })], rules.sensitivePaths);
    expect(flags).toHaveLength(1);
  });

  it("notices a file moved out of a sensitive directory", () => {
    const moved = makeFile({ path: "src/lib/session.ts", previousPath: "src/auth/session.ts", status: "renamed" });
    expect(scanSensitivePaths([moved], rules.sensitivePaths)).toHaveLength(1);
  });

  it("honors custom patterns and severity", () => {
    const custom = { ...rules.sensitivePaths, severity: "critical" as const, patterns: ["**/admin/**"] };
    const flags = scanSensitivePaths(
      [makeFile({ path: "src/admin/users.ts" }), makeFile({ path: "src/auth/login.ts" })],
      custom,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ severity: "critical", file: "src/admin/users.ts" });
  });
});

describe("scanDeletedTests", () => {
  const removed = (path: string) => makeFile({ path, status: "removed", deletions: 10 });

  it.each([
    "src/foo.test.ts",
    "src/foo.spec.jsx",
    "src/__tests__/foo.ts",
    "test/helpers/db.ts",
    "pkg/foo_test.go",
    "tests/test_login.py",
    "test_login.py",
    "spec/user_spec.rb",
    "src/FooTest.java",
  ])("flags deleted %s", (path) => {
    const flags = scanDeletedTests([removed(path)], rules.deletedTests);
    expect(flags).toEqual([{ rule: "deletedTests", severity: "medium", file: path, reason: "Test file deleted" }]);
  });

  it.each(["src/latest.ts", "src/contest.ts", "src/utils.ts"])("ignores deleted non-test file %s", (path) => {
    expect(scanDeletedTests([removed(path)], rules.deletedTests)).toEqual([]);
  });

  it("ignores test files that were added or modified", () => {
    const files = [
      makeFile({ path: "src/a.test.ts", status: "modified" }),
      makeFile({ path: "src/b.test.ts", status: "added" }),
    ];
    expect(scanDeletedTests(files, rules.deletedTests)).toEqual([]);
  });

  it("honors custom patterns and severity", () => {
    const custom = { ...rules.deletedTests, severity: "high" as const, patterns: ["checks/**"] };
    const flags = scanDeletedTests([removed("checks/a.sh"), removed("src/a.test.ts")], custom);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ severity: "high", file: "checks/a.sh" });
  });
});

describe("scanDependencies", () => {
  it.each([
    "package.json",
    "packages/api/package.json",
    "requirements.txt",
    "requirements-dev.txt",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "src/App/App.csproj",
  ])("flags manifest %s at manifest severity", (path) => {
    const flags = scanDependencies([makeFile({ path })], rules.dependencies);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ rule: "dependencies", severity: "medium", file: path });
    expect(flags[0]?.reason).toContain("manifest");
  });

  it.each(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "Cargo.lock", "poetry.lock"])(
    "flags lockfile %s at lockfile severity",
    (path) => {
      const flags = scanDependencies([makeFile({ path })], rules.dependencies);
      expect(flags).toHaveLength(1);
      expect(flags[0]).toMatchObject({ severity: "low", file: path });
      expect(flags[0]?.reason).toContain("Lockfile");
    },
  );

  it.each(["README.md", "src/package.json.ts", "src/lockfile.ts"])("ignores %s", (path) => {
    expect(scanDependencies([makeFile({ path })], rules.dependencies)).toEqual([]);
  });

  it("honors custom severities", () => {
    const custom = { ...rules.dependencies, severity: "high" as const, lockfileSeverity: "medium" as const };
    const flags = scanDependencies([makeFile({ path: "package.json" }), makeFile({ path: "yarn.lock" })], custom);
    expect(flags.map((f) => f.severity)).toEqual(["high", "medium"]);
  });

  it("isLockfile tells lockfiles from manifests", () => {
    expect(isLockfile("web/package-lock.json")).toBe(true);
    expect(isLockfile("package.json")).toBe(false);
  });
});

describe("scanMigrations", () => {
  it.each([
    "db/migrations/001_init.sql",
    "prisma/migrations/20240101_init/migration.sql",
    "alembic/versions/abc123_add_users.py",
    "sql/V12__add_users.sql",
    "prisma/schema.prisma",
    "db/migrate/20240101_add_x.rb",
  ])("flags %s", (path) => {
    const flags = scanMigrations([makeFile({ path, status: "added", patch: addedPatch("-- harmless") })], rules.migrations);
    expect(flags).toEqual([
      { rule: "migrations", severity: "medium", file: path, reason: "Database migration added or changed" },
    ]);
  });

  it("ignores non-migration files", () => {
    expect(scanMigrations([makeFile({ path: "src/db/query.ts" })], rules.migrations)).toEqual([]);
  });

  it.each([
    "DROP TABLE users;",
    "alter table users drop column email;",
    "TRUNCATE accounts;",
    "DELETE FROM sessions;",
    'await knex.schema.dropTable("users");',
    "table.dropColumn('email');",
    "remove_column :users, :name",
  ])("escalates to high for destructive statement: %s", (line) => {
    const file = makeFile({ path: "db/migrations/002.sql", patch: addedPatch(line) });
    const [flag] = scanMigrations([file], rules.migrations);
    expect(flag).toMatchObject({ severity: "high" });
    expect(flag?.reason).toContain("destructive");
  });

  it("only escalates on added lines, not removed ones", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-DROP TABLE old;", "+CREATE TABLE fresh (id int);"].join("\n");
    const [flag] = scanMigrations([makeFile({ path: "db/migrations/003.sql", patch })], rules.migrations);
    expect(flag?.severity).toBe("medium");
  });

  it("keeps the base severity when no patch is available", () => {
    const [flag] = scanMigrations([makeFile({ path: "db/migrations/big.sql", additions: 9000, patch: null })], rules.migrations);
    expect(flag?.severity).toBe("medium");
  });

  it("treats a deleted migration as high severity", () => {
    const [flag] = scanMigrations([makeFile({ path: "db/migrations/001.sql", status: "removed", deletions: 5 })], rules.migrations);
    expect(flag).toMatchObject({ severity: "high" });
    expect(flag?.reason).toContain("deleted");
  });

  it("honors custom patterns and severity", () => {
    const custom = { ...rules.migrations, severity: "low" as const, patterns: ["schema/**"] };
    const flags = scanMigrations(
      [makeFile({ path: "schema/v2.sql", patch: addedPatch("select 1") }), makeFile({ path: "db/migrations/1.sql" })],
      custom,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ severity: "low", file: "schema/v2.sql" });
  });
});

describe("scanSize", () => {
  const cfg = rules.largeDiff; // 800 lines, 50 files
  const filesOf = (count: number, linesEach: number) =>
    Array.from({ length: count }, (_, i) => makeFile({ path: `src/f${i}.ts`, additions: linesEach }));

  it("stays quiet for a normal PR", () => {
    expect(scanSize(filesOf(3, 100), cfg)).toEqual([]);
  });

  it("flags only above the line limit (exactly the limit is fine)", () => {
    expect(scanSize(filesOf(1, 800), cfg)).toEqual([]);
    const flags = scanSize(filesOf(1, 801), cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.reason).toContain("801");
    expect(flags[0]?.reason).toContain("800");
  });

  it("counts additions and deletions together", () => {
    const file = makeFile({ path: "a.ts", additions: 500, deletions: 400 });
    expect(scanSize([file], cfg)).toHaveLength(1);
  });

  it("flags only above the file limit", () => {
    expect(scanSize(filesOf(50, 1), cfg)).toEqual([]);
    const flags = scanSize(filesOf(51, 1), cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.reason).toContain("51 ");
  });

  it("excludes lockfile churn from both counts", () => {
    const files = [makeFile({ path: "package-lock.json", additions: 5000, deletions: 4000 }), ...filesOf(2, 10)];
    expect(scanSize(files, cfg)).toEqual([]);
  });

  it("can raise both flags at once, as PR-level flags with the configured severity", () => {
    const flags = scanSize(filesOf(60, 20), { ...cfg, severity: "high" });
    expect(flags).toHaveLength(2);
    for (const flag of flags) {
      expect(flag).toMatchObject({ rule: "largeDiff", severity: "high" });
      expect(flag.file).toBeUndefined();
    }
  });

  it("honors custom limits", () => {
    expect(scanSize(filesOf(1, 11), { ...cfg, maxChangedLines: 10 })).toHaveLength(1);
    expect(scanSize(filesOf(3, 1), { ...cfg, maxFiles: 2 })).toHaveLength(1);
  });
});
