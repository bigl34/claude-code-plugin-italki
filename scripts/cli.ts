#!/usr/bin/env npx tsx

import { z, createCommand, runCli, cliTypes } from "@local/cli-utils";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ItalkiClient } from "./italki-client.js";

export const commands = {

  "search-teachers": createCommand(
    z.object({
      sortBy: z.enum(["value", "session_count", "rating", "hidden_gem", "price_low", "price_high", "price_per_hour"]).optional().describe("Sort order (default: session_count)"),
      maxPrice: cliTypes.float(0).optional().describe("Maximum lesson price in USD"),
      minRating: cliTypes.float(0, 5).optional().describe("Minimum overall rating (0-5)"),
      minSessions: cliTypes.int(0).optional().describe("Minimum total lessons taught"),
      limit: cliTypes.limit(20, 100),
      refresh: z.preprocess((v) => v === true || v === "true", z.boolean()).optional().describe("Force re-index before searching"),
    }),
    async (args, client: ItalkiClient) => {
      const { refresh, ...filter } = args;
      return client.searchTeachers(filter, refresh);
    },
    "Search/filter teachers from local index (auto-indexes if empty, --refresh forces re-index)",
    { sideEffect: "read" }
  ),

  "teacher-profile": createCommand(
    z.object({
      id: cliTypes.int(1).describe("Teacher ID"),
    }),
    async (args, client: ItalkiClient) => {
      return client.getTeacherProfile(args.id);
    },
    "View detailed profile for a teacher from local index",
    { sideEffect: "read" }
  ),

  "index-teachers": createCommand(
    z.object({
      maxPages: cliTypes.int(1, 500).optional().describe("Max pages to fetch (20 teachers/page, default: 10)"),
    }),
    async (args, client: ItalkiClient) => {
      return client.indexTeachers(args.maxPages);
    },
    "Fetch teachers from italki API and index locally (default: 10 pages = ~200 teachers)",
    { sideEffect: "write" }
  ),


  "login": createCommand(
    z.object({}),
    async (_args, client: ItalkiClient) => client.login(),
    "Authenticate with italki (opens headed browser)",
    { sideEffect: "write" }
  ),

  "check-availability": createCommand(
    z.object({
      teacherId: cliTypes.int(1).describe("Teacher ID to check"),
    }),
    async (args, client: ItalkiClient) => {
      return client.checkAvailability(args.teacherId);
    },
    "View a teacher's available time slots",
    { sideEffect: "read" }
  ),

  "book-lesson": createCommand(
    z.object({
      teacherId: cliTypes.int(1).describe("Teacher ID to book with"),
      date: z.string().optional().describe("Lesson date (YYYY-MM-DD)"),
      time: z.string().optional().describe("Lesson time (HH:MM)"),
      duration: cliTypes.int(30, 90).optional().describe("Duration in minutes (default: 60)"),
      lessonType: z.enum(["standard", "trial"]).optional().describe("Lesson type (default: standard)"),
      dryRun: z.preprocess((v) => v === undefined || v === true || v === "true", z.boolean()).optional().describe("Preview only, don't submit (default: true)"),
    }),
    async (args, client: ItalkiClient) => {
      const opts = args;
      if (opts.dryRun === false && (!opts.date || !opts.time)) {
        throw new Error("Actual italki booking requires both --date YYYY-MM-DD and --time HH:MM");
      }
      return client.bookLesson(opts);
    },
    "Book a lesson (--dry-run for preview only, default). Omit --dry-run=false to submit.",
    { sideEffect: "external_send", requiresConfirmation: true, dryRunSupported: true }
  ),

  "list-lessons": createCommand(
    z.object({
      status: z.enum(["upcoming", "completed", "cancelled", "all"]).optional().describe("Filter by lesson status (default: all)"),
    }),
    async (args, client: ItalkiClient) => {
      return client.listLessons(args.status);
    },
    "View upcoming/past lessons",
    { sideEffect: "read" }
  ),

  "reset": createCommand(
    z.object({}),
    async (_args, client: ItalkiClient) => client.reset(),
    "Close browser and clear session",
    { sideEffect: "destructive" }
  ),


  "budget": createCommand(
    z.object({
      monthly: cliTypes.float(0).optional().describe("Set monthly budget cap in USD (omit to view status)"),
    }),
    async (args, client: ItalkiClient) => {
      const monthly = args.monthly;
      if (monthly !== undefined) {
        return client.setBudget(monthly);
      }
      return client.getBudgetStatus();
    },
    "View or set monthly lesson budget (--monthly N to set)",
    { sideEffect: "write" }
  ),

  "notes": createCommand(
    z.object({
      teacherId: cliTypes.int(1).describe("Teacher ID"),
      add: z.string().optional().describe("Note text to add"),
      type: z.enum(["general", "vocabulary", "homework", "feedback", "characters", "pinyin", "tones"]).optional().describe("Note type (default: general)"),
    }),
    async (args, client: ItalkiClient) => {
      const { teacherId, add, type } = args;
      if (add) {
        return client.addNote(teacherId, add, type || "general");
      }
      return client.getNotes(teacherId);
    },
    "Add or view lesson notes for a teacher (--add '...' to add)",
    { sideEffect: "write" }
  ),
};

let isCliEntry = false;
try {
  isCliEntry =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isCliEntry = false;
}

if (isCliEntry) {
  runCli(commands, ItalkiClient, {
    programName: "italki-cli",
    description: "italki teacher search, indexing, and lesson booking",
  });
}
