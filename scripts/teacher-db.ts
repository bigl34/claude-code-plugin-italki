
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { Teacher, TeacherFilter, IndexStats, ApiTeacher } from "./types.js";

export function resolveTeacherDbPaths(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): { path: string; legacyPath: string } {
  const stateDirectory = env.ITALKI_STATE_DIR
    || join(env.BIZ_ROOT || join(home, "biz"), "var", "italki-manager"); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    path: join(stateDirectory, "teachers.db"),
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    legacyPath: join(home, ".cache", "italki-manager", "teachers.db"),
  };
}

function migrateLegacyDatabase(path: string, legacyPath: string): void {
  if (existsSync(path) || !existsSync(legacyPath)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const legacy = new Database(legacyPath, { readonly: true, fileMustExist: true });
  try {
    const quotedPath = temporaryPath.replaceAll("'", "''");
    legacy.exec(`VACUUM INTO '${quotedPath}'`);
    chmodSync(temporaryPath, 0o600);
    try {
      linkSync(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    legacy.close();
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function defaultDbPath(): string {
  const paths = resolveTeacherDbPaths();
  migrateLegacyDatabase(paths.path, paths.legacyPath);
  return paths.path;
}

export class TeacherDB {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const managedPath = dbPath === undefined;
    const resolvedPath = dbPath ?? defaultDbPath();
    if (resolvedPath !== ":memory:") {
      const dir = dirname(resolvedPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: managedPath ? 0o700 : undefined });
      }
      if (managedPath) chmodSync(dir, 0o700);
    }

    this.db = new Database(resolvedPath);
    try {
      if (managedPath) chmodSync(resolvedPath, 0o600);

      const busyTimeoutMs = 5_000;
      const walDeadline = Date.now() + busyTimeoutMs;
      const waitCell = new Int32Array(new SharedArrayBuffer(4));
      this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      while (true) {
        try {
          this.db.pragma("journal_mode = WAL");
          break;
        } catch (error) {
          const remainingMs = walDeadline - Date.now();
          if ((error as { code?: string }).code !== "SQLITE_BUSY" || remainingMs <= 0) {
            throw error;
          }
          Atomics.wait(waitCell, 0, 0, Math.min(25, remainingMs));
        }
      }
      this.db.pragma("foreign_keys = ON");

      this.initSchema();
    } catch (error) {
      try {
        this.db.close();
      } catch {
      }
      throw error;
    }
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

    const migrateColumns = this.db.transaction(() => {
      const columns = this.db.pragma("table_info('teachers')") as Array<{ name: string }>;
      const existingCols = new Set(columns.map(c => c.name));
      for (const [colName, colType] of newCols) {
        if (!existingCols.has(colName)) {
          this.db.prepare(`ALTER TABLE teachers ADD COLUMN ${colName} ${colType}`).run();
        }
      }
    });
    migrateColumns.immediate();

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_price_30m ON teachers(price_30m ASC);
      CREATE INDEX IF NOT EXISTS idx_hourly_rate ON teachers(hourly_rate ASC);
    `);
  }

  private extractPrices(courseDetails: Array<{ price_list: Array<{
    session_price: number; session_length: number;
    package_length: number; package_price: number;
  }> }>): {
    price_30m: number | null; price_45m: number | null;
    price_60m: number | null; price_90m: number | null;
    hourly_rate: number | null;
  } {
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

  private computeValueScore(sessionCount: number, lessonPrice: number): number {
    if (lessonPrice <= 0) return 0;
    return parseFloat((sessionCount / lessonPrice).toFixed(2));
  }

  private computeHiddenGemScore(rating: number, sessionCount: number): number {
    return parseFloat((rating * (1 / Math.log2(sessionCount + 2))).toFixed(4));
  }

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
        const rating = parseFloat(t.teacher_info?.overall_rating ?? "0") || 0;
        const lessonPriceCents = t.course_info?.min_price ?? 0;
        const trialPriceCents = t.course_info?.trial_price ?? 0;
        const trialPrice = trialPriceCents / 100;

        const prices = this.extractPrices(t.pro_course_detail || []);
        const standardLessonPrice =
          prices.price_30m ??
          prices.price_45m ??
          prices.price_60m ??
          prices.price_90m;
        const lessonPrice = standardLessonPrice ?? lessonPriceCents / 100;

        const stats = t.teacher_statistics;
        const responseRate = stats?.response_rate ?? null;
        const attendanceRate = stats?.attendance_rate ?? null;
        const studentCount = t.teacher_info?.student_count ?? null;
        const timezone = t.user_info.timezone || null;

        const trialLengthUnits = t.course_info?.trial_length ?? 0;
        const trialLength = trialLengthUnits > 0 ? trialLengthUnits * 15 : null;

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

  getById(id: number): Teacher | null {
    const row = this.db.prepare("SELECT * FROM teachers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { ...row, is_pro: Boolean(row.is_pro) } as unknown as Teacher;
  }

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

  prune(olderThanDays: number = 30): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const result = this.db.prepare("DELETE FROM teachers WHERE last_seen_at < ?").run(cutoff.toISOString());
    return result.changes;
  }

  isEmpty(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM teachers").get() as { count: number };
    return row.count === 0;
  }

  close(): void {
    this.db.close();
  }
}
