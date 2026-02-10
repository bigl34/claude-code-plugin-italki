/**
 * italki Teacher Database
 *
 * SQLite storage for the local teacher index using better-sqlite3.
 * Features:
 * - Efficient upsert with transaction batching
 * - Computed scores: value_score, hidden_gem_score
 * - Dynamic search with WHERE/ORDER BY from filter objects
 * - WAL mode for concurrent read safety
 * - Pruning of stale records
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { Teacher, TeacherFilter, IndexStats, ApiTeacher } from "./types.js";

const DB_PATH = `${process.env.HOME}/.cache/italki-manager/teachers.db`;

export class TeacherDB {
  private db: Database.Database;

  constructor() {
    // Ensure directory exists
    const dir = dirname(DB_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(DB_PATH);

    // WAL mode for concurrent read safety
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teachers (
        id INTEGER PRIMARY KEY,
        nickname TEXT NOT NULL DEFAULT 'Unknown',
        avatar_url TEXT DEFAULT '',
        origin_country TEXT DEFAULT '',
        living_country TEXT DEFAULT '',
        is_pro INTEGER DEFAULT 0,
        session_count INTEGER DEFAULT 0,
        overall_rating REAL DEFAULT 0,
        lesson_price REAL DEFAULT 0,
        trial_price REAL DEFAULT 0,
        value_score REAL DEFAULT 0,
        hidden_gem_score REAL DEFAULT 0,
        profile_url TEXT DEFAULT '',
        last_seen_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_count ON teachers(session_count DESC);
      CREATE INDEX IF NOT EXISTS idx_overall_rating ON teachers(overall_rating DESC);
      CREATE INDEX IF NOT EXISTS idx_value_score ON teachers(value_score DESC);
      CREATE INDEX IF NOT EXISTS idx_lesson_price ON teachers(lesson_price ASC);
      CREATE INDEX IF NOT EXISTS idx_hidden_gem_score ON teachers(hidden_gem_score DESC);
      CREATE INDEX IF NOT EXISTS idx_last_seen_at ON teachers(last_seen_at);
    `);

    // Migrate: add new columns if they don't exist yet
    const columns = this.db.pragma("table_info('teachers')") as Array<{ name: string }>;
    const existingCols = new Set(columns.map(c => c.name));

    const newCols: [string, string][] = [
      ["price_30m", "REAL"],
      ["price_45m", "REAL"],
      ["price_60m", "REAL"],
      ["price_90m", "REAL"],
      ["hourly_rate", "REAL"],
      ["response_rate", "REAL"],
      ["attendance_rate", "REAL"],
      ["student_count", "INTEGER"],
      ["timezone", "TEXT"],
      ["trial_length", "INTEGER"],
      ["course_detail_json", "TEXT"],
    ];

    for (const [colName, colType] of newCols) {
      if (!existingCols.has(colName)) {
        this.db.prepare(`ALTER TABLE teachers ADD COLUMN ${colName} ${colType}`).run();
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_price_30m ON teachers(price_30m ASC);
      CREATE INDEX IF NOT EXISTS idx_hourly_rate ON teachers(hourly_rate ASC);
    `);
  }

  /**
   * Extract cheapest per-session price for each duration from pro_course_detail.
   * Returns prices in USD (converted from cents) and a normalized hourly rate.
   */
  private extractPrices(courseDetails: Array<{ price_list: Array<{
    session_price: number; session_length: number;
    package_length: number; package_price: number;
  }> }>): {
    price_30m: number | null; price_45m: number | null;
    price_60m: number | null; price_90m: number | null;
    hourly_rate: number | null;
  } {
    // Map: session_length code → cheapest session_price (cents)
    const mins: Record<number, number> = {};

    for (const course of courseDetails) {
      for (const p of course.price_list) {
        if (p.session_price > 0 && [2, 3, 4, 6].includes(p.session_length)) {
          if (!(p.session_length in mins) || p.session_price < mins[p.session_length]) {
            mins[p.session_length] = p.session_price;
          }
        }
      }
    }

    const toDollars = (cents: number | undefined) => cents != null ? cents / 100 : null;
    const prices = {
      price_30m: toDollars(mins[2]),
      price_45m: toDollars(mins[3]),
      price_60m: toDollars(mins[4]),
      price_90m: toDollars(mins[6]),
    };

    // Compute hourly_rate from first available duration (priority: 30m, 45m, 60m, 90m)
    const durationMins = [
      { price: prices.price_30m, mins: 30 },
      { price: prices.price_45m, mins: 45 },
      { price: prices.price_60m, mins: 60 },
      { price: prices.price_90m, mins: 90 },
    ];
    const cheapest = durationMins.find(d => d.price != null);
    const hourly_rate = cheapest ? parseFloat(((cheapest.price! / cheapest.mins) * 60).toFixed(2)) : null;

    return { ...prices, hourly_rate };
  }

  /**
   * Compute value_score: sessions per dollar spent.
   * Higher = more experienced per unit cost.
   */
  private computeValueScore(sessionCount: number, lessonPrice: number): number {
    if (lessonPrice <= 0) return 0;
    return parseFloat((sessionCount / lessonPrice).toFixed(2));
  }

  /**
   * Compute hidden_gem_score: high rating but low visibility.
   * Formula: rating * (1 / log2(session_count + 2))
   * Teachers with high ratings but few sessions score highest.
   */
  private computeHiddenGemScore(rating: number, sessionCount: number): number {
    return parseFloat((rating * (1 / Math.log2(sessionCount + 2))).toFixed(4));
  }

  /**
   * Upsert a batch of API teachers into the database.
   * Uses a transaction for atomicity and performance.
   *
   * @returns Number of teachers upserted
   */
  upsertBatch(apiTeachers: ApiTeacher[]): number {
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO teachers (
        id, nickname, avatar_url, origin_country, living_country, is_pro,
        session_count, overall_rating, lesson_price, trial_price,
        value_score, hidden_gem_score, profile_url, last_seen_at, indexed_at,
        price_30m, price_45m, price_60m, price_90m, hourly_rate,
        response_rate, attendance_rate, student_count, timezone,
        trial_length, course_detail_json
      ) VALUES (
        @id, @nickname, @avatar_url, @origin_country, @living_country, @is_pro,
        @session_count, @overall_rating, @lesson_price, @trial_price,
        @value_score, @hidden_gem_score, @profile_url, @last_seen_at, @indexed_at,
        @price_30m, @price_45m, @price_60m, @price_90m, @hourly_rate,
        @response_rate, @attendance_rate, @student_count, @timezone,
        @trial_length, @course_detail_json
      )
    `);

    const upsertAll = this.db.transaction((teachers: ApiTeacher[]) => {
      let count = 0;
      for (const t of teachers) {
        const userId = t.user_info.user_id;
        const sessionCount = t.teacher_info?.session_count ?? 0;
        // API returns rating as string (e.g. "4.9")
        const rating = parseFloat(t.teacher_info?.overall_rating ?? "0") || 0;
        // Prices are in course_info, in cents — convert to dollars
        const lessonPriceCents = t.course_info?.min_price ?? 0;
        const trialPriceCents = t.course_info?.trial_price ?? 0;
        const trialPrice = trialPriceCents / 100;

        // Extract per-duration pricing from pro_course_detail
        const prices = this.extractPrices(t.pro_course_detail || []);
        // Use 30m price if available, fall back to min_price for backward compat
        const lessonPrice = prices.price_30m ?? lessonPriceCents / 100;

        // Teacher quality metrics (use ?? to preserve 0 as a valid value)
        const stats = t.teacher_statistics;
        const responseRate = stats?.response_rate ?? null;
        const attendanceRate = stats?.attendance_rate ?? null;
        const studentCount = t.teacher_info?.student_count ?? null;
        const timezone = t.user_info.timezone || null;

        // Trial length: API returns in 15-min units, convert to minutes
        const trialLengthUnits = t.course_info?.trial_length ?? 0;
        const trialLength = trialLengthUnits > 0 ? trialLengthUnits * 15 : null;

        // Store raw course detail for future use
        const courseDetailJson = t.pro_course_detail?.length
          ? JSON.stringify(t.pro_course_detail)
          : null;

        stmt.run({
          id: userId,
          nickname: t.user_info.nickname || "Unknown",
          avatar_url: t.user_info.avatar_file_name || "",
          origin_country: t.user_info.origin_country_id || "",
          living_country: t.user_info.living_country_id || "",
          is_pro: t.user_info.is_pro ? 1 : 0,
          session_count: sessionCount,
          overall_rating: rating,
          lesson_price: lessonPrice,
          trial_price: trialPrice,
          value_score: this.computeValueScore(sessionCount, lessonPrice),
          hidden_gem_score: this.computeHiddenGemScore(rating, sessionCount),
          profile_url: `https://www.italki.com/en/teacher/${userId}`,
          last_seen_at: now,
          indexed_at: now,
          price_30m: prices.price_30m,
          price_45m: prices.price_45m,
          price_60m: prices.price_60m,
          price_90m: prices.price_90m,
          hourly_rate: prices.hourly_rate,
          response_rate: responseRate,
          attendance_rate: attendanceRate,
          student_count: studentCount,
          timezone,
          trial_length: trialLength,
          course_detail_json: courseDetailJson,
        });
        count++;
      }
      return count;
    });

    return upsertAll(apiTeachers);
  }

  /**
   * Search teachers with dynamic filtering and sorting.
   */
  search(filter: TeacherFilter = {}): Teacher[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.maxPrice !== undefined) {
      conditions.push("lesson_price <= @maxPrice");
      params.maxPrice = filter.maxPrice;
    }
    if (filter.minRating !== undefined) {
      conditions.push("overall_rating >= @minRating");
      params.minRating = filter.minRating;
    }
    if (filter.minSessions !== undefined) {
      conditions.push("session_count >= @minSessions");
      params.minSessions = filter.minSessions;
    }
    if (filter.isPro !== undefined) {
      conditions.push("is_pro = @isPro");
      params.isPro = filter.isPro ? 1 : 0;
    }

    // Sorting — uses a whitelist to prevent SQL injection
    const sortMap: Record<string, string> = {
      value: "value_score DESC",
      session_count: "session_count DESC",
      rating: "overall_rating DESC",
      hidden_gem: "hidden_gem_score DESC",
      price_low: "lesson_price ASC",
      price_high: "lesson_price DESC",
      price_per_hour: "hourly_rate IS NULL, hourly_rate ASC",
    };
    const orderBy = sortMap[filter.sortBy || "session_count"] || "session_count DESC";

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit || 20;

    const sql = `SELECT * FROM teachers ${where} ORDER BY ${orderBy} LIMIT @limit`;
    params.limit = limit;

    const rows = this.db.prepare(sql).all(params) as Record<string, unknown>[];

    return rows.map((row) => ({
      ...row,
      is_pro: Boolean(row.is_pro),
    })) as unknown as Teacher[];
  }

  /**
   * Get a single teacher by ID.
   */
  getById(id: number): Teacher | null {
    const row = this.db.prepare("SELECT * FROM teachers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { ...row, is_pro: Boolean(row.is_pro) } as unknown as Teacher;
  }

  /**
   * Get index statistics.
   */
  getStats(): IndexStats {
    const countRow = this.db.prepare("SELECT COUNT(*) as count FROM teachers").get() as { count: number };
    const statsRow = this.db.prepare(`
      SELECT
        AVG(overall_rating) as avg_rating,
        AVG(lesson_price) as avg_price,
        AVG(hourly_rate) as avg_hourly_rate,
        AVG(session_count) as avg_sessions,
        MAX(indexed_at) as last_indexed
      FROM teachers
    `).get() as { avg_rating: number | null; avg_price: number | null; avg_hourly_rate: number | null; avg_sessions: number | null; last_indexed: string | null };

    const topRow = this.db.prepare(
      "SELECT nickname FROM teachers ORDER BY session_count DESC LIMIT 1"
    ).get() as { nickname: string } | undefined;

    return {
      totalTeachers: countRow.count,
      lastIndexedAt: statsRow.last_indexed,
      avgRating: parseFloat((statsRow.avg_rating ?? 0).toFixed(2)),
      avgPrice: parseFloat((statsRow.avg_price ?? 0).toFixed(2)),
      avgHourlyRate: statsRow.avg_hourly_rate != null ? parseFloat(statsRow.avg_hourly_rate.toFixed(2)) : null,
      avgSessions: parseFloat((statsRow.avg_sessions ?? 0).toFixed(0)),
      topBySessionCount: topRow?.nickname ?? "N/A",
    };
  }

  /**
   * Remove teachers not seen in recent indexes.
   * @param olderThanDays - Remove records older than this many days
   * @returns Number of records pruned
   */
  prune(olderThanDays: number = 30): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const result = this.db.prepare("DELETE FROM teachers WHERE last_seen_at < ?").run(cutoff.toISOString());
    return result.changes;
  }

  /**
   * Check if the database has any data.
   */
  isEmpty(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM teachers").get() as { count: number };
    return row.count === 0;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
