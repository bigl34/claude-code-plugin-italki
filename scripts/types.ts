
import { z } from "zod";


const PriceListItemSchema = z.object({
  session_price: z.number(),
  session_length: z.number(),
  package_length: z.number(),
  package_price: z.number(),
}).passthrough();

const CourseDetailSchema = z.object({
  price_list: z.array(PriceListItemSchema).optional().default([]),
}).passthrough();

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
    overall_rating: z.string().optional().default("0"),
    student_count: z.number().optional().default(0),
    teach_language: z.array(z.object({
      language: z.string().optional().default(""),
    }).passthrough()).optional().default([]),
  }).passthrough(),
  teacher_statistics: z.object({
    response_rate: z.number().optional().default(0),
    attendance_rate: z.number().optional().default(0),
    finished_session: z.number().optional().default(0),
  }).passthrough().optional().default({ response_rate: 0, attendance_rate: 0, finished_session: 0 }),
  course_info: z.object({
    trial_price: z.number().optional().default(0),
    min_price: z.number().optional().default(0),
    has_trial: z.union([z.boolean(), z.number()]).transform(v => Boolean(v)).optional().default(false),
    trial_length: z.number().optional().default(0),
    trial_description: z.string().optional().default(""),
  }).passthrough().optional().default({ trial_price: 0, min_price: 0, has_trial: false, trial_length: 0, trial_description: "" }),
  pro_course_detail: z.array(CourseDetailSchema).optional().default([]),
}).passthrough();

export const ApiTeacherListSchema = z.object({
  data: z.array(ApiTeacherSchema),
  paging: z.object({
    page: z.number(),
    page_size: z.number(),
    total: z.number(),
    has_next: z.union([z.boolean(), z.number()]).transform(v => Boolean(v)),
  }).passthrough().optional(),
}).passthrough();

export type ApiTeacher = z.infer<typeof ApiTeacherSchema>;
export type ApiTeacherList = z.infer<typeof ApiTeacherListSchema>;


export interface Teacher {
  id: number;
  nickname: string;
  avatar_url: string;
  origin_country: string;
  living_country: string;
  is_pro: boolean;
  session_count: number;
  overall_rating: number;
  lesson_price: number;
  trial_price: number;
  value_score: number;
  hidden_gem_score: number;
  profile_url: string;
  last_seen_at: string;
  indexed_at: string;
  price_30m: number | null;
  price_45m: number | null;
  price_60m: number | null;
  price_90m: number | null;
  hourly_rate: number | null;
  response_rate: number | null;
  attendance_rate: number | null;
  student_count: number | null;
  timezone: string | null;
  trial_length: number | null;
  course_detail_json: string | null;
}

export interface TeacherFilter {
  sortBy?: "value" | "session_count" | "rating" | "hidden_gem" | "price_low" | "price_high" | "price_per_hour";
  maxPrice?: number;
  minRating?: number;
  minSessions?: number;
  isPro?: boolean;
  limit?: number;
}

export interface IndexStats {
  totalTeachers: number;
  lastIndexedAt: string | null;
  avgRating: number;
  avgPrice: number;
  avgHourlyRate: number | null;
  avgSessions: number;
  topBySessionCount: string;
}


export const ItalkiConfigSchema = z.object({
  italki: z.object({
    email: z.string().trim().min(1, "italki email is required"),
    password: z.string().trim().min(1, "italki password is required"),
    language: z.string().trim().min(1, "italki language slug is required (e.g. 'chinese')"),
  }).strict(),
}).strict();

export type ItalkiConfig = z.infer<typeof ItalkiConfigSchema>;


export interface TimeSlot {
  date: string;
  time: string;
  duration: number;
  available: boolean;
}

export interface BookingPreview {
  teacherId: number;
  teacherName: string;
  lessonType: "standard" | "trial";
  date: string;
  time: string;
  duration: number;
  cost: number;
  bookingType: "instant" | "request";
  screenshot: string;
}

export interface BookingResult {
  success: boolean;
  teacherId: number;
  teacherName: string;
  startTime: string;
  endTime: string;
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


export interface BudgetData {
  monthlyCap: number;
  entries: BudgetEntry[];
}

export interface BudgetEntry {
  date: string;
  teacherName: string;
  cost: number;
  lessonType: string;
}

export interface BudgetStatus {
  monthlyCap: number;
  currentMonth: string;
  spent: number;
  remaining: number;
  lessonsThisMonth: number;
  overBudget: boolean;
  entries: BudgetEntry[];
}


export interface SessionInfo {
  storageStatePath: string;
  createdAt: string;
  loggedIn: boolean;
}
