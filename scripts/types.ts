/**
 * italki Manager - Type Definitions
 *
 * All TypeScript interfaces for the italki plugin:
 * - API response shapes (with Zod schemas for runtime validation)
 * - Database models
 * - Client configuration
 * - CLI argument types
 */

import { z } from "zod";

// ============================================
// API Response Schemas (Zod runtime validation)
// ============================================

// Course pricing schemas
const PriceListItemSchema = z.object({
  session_price: z.number(),      // per-session price in cents
  session_length: z.number(),     // 2=30min, 3=45min, 4=60min, 6=90min
  package_length: z.number(),     // number of sessions in package
  package_price: z.number(),      // total package price in cents
}).passthrough();

const CourseDetailSchema = z.object({
  price_list: z.array(PriceListItemSchema).optional().default([]),
}).passthrough();

/**
 * Zod schema for a single teacher from the italki API.
 * Validates runtime responses so we fail fast if the undocumented API changes.
 *
 * Actual API structure (as of 2026-02):
 * - user_info: { user_id, nickname, is_pro, origin_country_id, living_country_id, timezone, ... }
 * - teacher_info: { session_count, overall_rating (string!), student_count, teach_language [{language: "chinese"}], ... }
 * - teacher_statistics: { response_rate, attendance_rate, finished_session, ... }
 * - course_info: { trial_price (cents), min_price (cents), trial_length, trial_description, ... }
 * - pro_course_detail: [{ price_list: [{ session_price, session_length, ... }] }]
 */
export const ApiTeacherSchema = z.object({
  user_info: z.object({
    user_id: z.number(),
    nickname: z.string().optional().default("Unknown"),
    avatar_file_name: z.string().optional().default(""),
    is_pro: z.union([z.boolean(), z.number()]).transform(v => Boolean(v)).optional().default(false),
    origin_country_id: z.string().optional().default(""),
    living_country_id: z.string().optional().default(""),
    timezone: z.string().optional().default(""),
  }).passthrough(),
  teacher_info: z.object({
    session_count: z.number().optional().default(0),
    overall_rating: z.string().optional().default("0"),  // API returns string like "4.9"
    student_count: z.number().optional().default(0),
    teach_language: z.array(z.object({
      language: z.string().optional().default(""),  // e.g. "chinese", "spanish", "german"
    }).passthrough()).optional().default([]),
  }).passthrough(),
  teacher_statistics: z.object({
    response_rate: z.number().optional().default(0),     // 0-1
    attendance_rate: z.number().optional().default(0),    // 0-1
    finished_session: z.number().optional().default(0),
  }).passthrough().optional().default({ response_rate: 0, attendance_rate: 0, finished_session: 0 }),
  course_info: z.object({
    trial_price: z.number().optional().default(0),   // price in cents (USD)
    min_price: z.number().optional().default(0),      // price in cents (USD)
    has_trial: z.union([z.boolean(), z.number()]).transform(v => Boolean(v)).optional().default(false),
    trial_length: z.number().optional().default(0),  // in 15-min units
    trial_description: z.string().optional().default(""),
  }).passthrough().optional().default({ trial_price: 0, min_price: 0, has_trial: false, trial_length: 0, trial_description: "" }),
  pro_course_detail: z.array(CourseDetailSchema).optional().default([]),
}).passthrough(); // Allow unknown fields to avoid breaking on API additions

/**
 * Zod schema for the API list response wrapper.
 */
export const ApiTeacherListSchema = z.object({
  data: z.array(ApiTeacherSchema),
  paging: z.object({
    page: z.number(),
    page_size: z.number(),
    total: z.number(),
    has_next: z.union([z.boolean(), z.number()]).transform(v => Boolean(v)),
  }).passthrough().optional(),
}).passthrough();

// Inferred types from Zod
export type ApiTeacher = z.infer<typeof ApiTeacherSchema>;
export type ApiTeacherList = z.infer<typeof ApiTeacherListSchema>;

// ============================================
// Database Models
// ============================================

/** A teacher record as stored in SQLite. */
export interface Teacher {
  id: number;
  nickname: string;
  avatar_url: string;
  origin_country: string;
  living_country: string;
  is_pro: boolean;
  session_count: number;
  overall_rating: number;
  lesson_price: number;       // USD decimal (converted from cents)
  trial_price: number;        // USD decimal
  value_score: number;        // session_count / lesson_price
  hidden_gem_score: number;   // rating * (1 / log2(session_count + 2))
  profile_url: string;
  last_seen_at: string;       // ISO 8601
  indexed_at: string;         // ISO 8601
  // Per-duration pricing (USD decimal, null if duration not offered)
  price_30m: number | null;
  price_45m: number | null;
  price_60m: number | null;
  price_90m: number | null;
  hourly_rate: number | null;        // normalized: cheapest available duration → $/hr
  // Teacher quality metrics
  response_rate: number | null;      // 0-1
  attendance_rate: number | null;    // 0-1
  student_count: number | null;
  timezone: string | null;
  trial_length: number | null;       // minutes (converted from 15-min units)
  course_detail_json: string | null; // raw JSON blob for future use
}

/** Filter criteria for teacher search. */
export interface TeacherFilter {
  sortBy?: "value" | "session_count" | "rating" | "hidden_gem" | "price_low" | "price_high" | "price_per_hour";
  maxPrice?: number;
  minRating?: number;
  minSessions?: number;
  isPro?: boolean;
  limit?: number;
}

/** Stats about the teacher index. */
export interface IndexStats {
  totalTeachers: number;
  lastIndexedAt: string | null;
  avgRating: number;
  avgPrice: number;
  avgHourlyRate: number | null;
  avgSessions: number;
  topBySessionCount: string;  // nickname
}

// ============================================
// Client Configuration
// ============================================

export const ItalkiConfigSchema = z.object({
  italki: z.object({
    email: z.string().trim().min(1, "italki email is required"),
    password: z.string().trim().min(1, "italki password is required"),
    language: z.string().trim().min(1, "italki language slug is required (e.g. 'chinese')"),
  }).strict(),
}).strict();

export type ItalkiConfig = z.infer<typeof ItalkiConfigSchema>;

// ============================================
// Browser Client Types
// ============================================

export interface TimeSlot {
  date: string;          // YYYY-MM-DD
  time: string;          // HH:MM (user's local timezone)
  duration: number;      // minutes
  available: boolean;
}

export interface BookingPreview {
  teacherId: number;
  teacherName: string;
  lessonType: "standard" | "trial";
  date: string;
  time: string;
  duration: number;
  cost: number;          // USD
  bookingType: "instant" | "request";
  screenshot: string;
}

export interface BookingResult {
  success: boolean;
  teacherId: number;
  teacherName: string;
  startTime: string;     // ISO 8601
  endTime: string;       // ISO 8601
  cost: number;
  bookingType: "instant" | "request";
  bookingId?: string;
  screenshot: string;
}

export interface LessonInfo {
  id: string;
  teacherName: string;
  date: string;
  time: string;
  duration: number;
  status: "upcoming" | "completed" | "cancelled";
  lessonType: string;
  cost?: number;
}

// ============================================
// Budget Types
// ============================================

export interface BudgetData {
  monthlyCap: number;
  entries: BudgetEntry[];
}

export interface BudgetEntry {
  date: string;          // ISO 8601
  teacherName: string;
  cost: number;          // USD
  lessonType: string;
}

export interface BudgetStatus {
  monthlyCap: number;
  currentMonth: string;  // YYYY-MM
  spent: number;
  remaining: number;
  lessonsThisMonth: number;
  overBudget: boolean;
  entries: BudgetEntry[];
}

// ============================================
// Session Management
// ============================================

export interface SessionInfo {
  storageStatePath: string;
  createdAt: string;
  loggedIn: boolean;
}
