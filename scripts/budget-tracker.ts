
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "node:crypto";
import { homedir } from "os";
import { dirname, join } from "path";
import type { BudgetData, BudgetEntry, BudgetStatus } from "./types.js";

export function resolveBudgetPaths(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): { path: string; legacyPath: string } {
  const stateDirectory = env.ITALKI_STATE_DIR
    || join(env.BIZ_ROOT || join(home, "biz"), "var", "italki-manager"); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    path: join(stateDirectory, "budget.json"),
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    legacyPath: join(home, ".cache", "italki-manager", "budget.json"),
  };
}

const BUDGET_PATHS = resolveBudgetPaths();

type BudgetPaths = ReturnType<typeof resolveBudgetPaths>;

export function migrateLegacyBudget(paths: BudgetPaths = BUDGET_PATHS): void {
  if (existsSync(paths.path) || !existsSync(paths.legacyPath)) return;
  const directory = dirname(paths.path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = `${paths.path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    copyFileSync(
      paths.legacyPath,
      temporaryPath,
      constants.COPYFILE_EXCL,
    );
    chmodSync(temporaryPath, 0o600);
    const data = JSON.parse(readFileSync(temporaryPath, "utf8")) as Partial<BudgetData>;
    const validEntries = Array.isArray(data.entries) && data.entries.every((entry) => (
      entry !== null
      && typeof entry === "object"
      && typeof entry.date === "string"
      && typeof entry.teacherName === "string"
      && Number.isFinite(entry.cost)
      && typeof entry.lessonType === "string"
    ));
    if (!Number.isFinite(data.monthlyCap) || !validEntries) {
      throw new TypeError("Legacy italki budget has an invalid schema");
    }
    const fileDescriptor = openSync(temporaryPath, "r");
    try {
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    try {
      linkSync(temporaryPath, paths.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class BudgetTracker {
  private data: BudgetData;

  constructor() {
    this.data = this.load();
  }

  private load(): BudgetData {
    migrateLegacyBudget();
    if (existsSync(BUDGET_PATHS.path)) {
      try {
        return JSON.parse(readFileSync(BUDGET_PATHS.path, "utf-8"));
      } catch {
      }
    }
    return { monthlyCap: 0, entries: [] };
  }

  private save(): void {
    const dir = dirname(BUDGET_PATHS.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    chmodSync(dir, 0o700);

    const tmpPath = `${BUDGET_PATHS.path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmpPath, BUDGET_PATHS.path);
  }

  setMonthlyCap(amount: number): void {
    this.data.monthlyCap = amount;
    this.save();
  }

  addEntry(entry: BudgetEntry): void {
    this.data.entries.push(entry);
    this.save();
  }

  getStatus(): BudgetStatus {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const monthEntries = this.data.entries.filter((e) => e.date.startsWith(currentMonth));
    const spent = monthEntries.reduce((sum, e) => sum + e.cost, 0);

    return {
      monthlyCap: this.data.monthlyCap,
      currentMonth,
      spent: parseFloat(spent.toFixed(2)),
      remaining: parseFloat((this.data.monthlyCap - spent).toFixed(2)),
      lessonsThisMonth: monthEntries.length,
      overBudget: this.data.monthlyCap > 0 && spent > this.data.monthlyCap,
      entries: monthEntries,
    };
  }
}

