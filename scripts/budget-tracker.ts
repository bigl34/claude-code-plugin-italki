/**
 * italki Budget Tracker
 *
 * Tracks monthly lesson spending against a configurable cap.
 * Data stored in JSON with atomic writes (temp file + rename).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import type { BudgetData, BudgetEntry, BudgetStatus } from "./types.js";

const BUDGET_PATH = `${process.env.HOME}/.cache/italki-manager/budget.json`;

export class BudgetTracker {
  private data: BudgetData;

  constructor() {
    this.data = this.load();
  }

  private load(): BudgetData {
    if (existsSync(BUDGET_PATH)) {
      try {
        return JSON.parse(readFileSync(BUDGET_PATH, "utf-8"));
      } catch {
        // Corrupted file — start fresh
      }
    }
    return { monthlyCap: 0, entries: [] };
  }

  /**
   * Atomic write: write to temp file, then rename.
   * Prevents corruption if the process crashes mid-write.
   */
  private save(): void {
    const dir = dirname(BUDGET_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const tmpPath = `${BUDGET_PATH}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.data, null, 2));
    renameSync(tmpPath, BUDGET_PATH);
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
