
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "fs";
import { loadServiceConfig } from "@local/cli-utils";
import { ItalkiApiClient } from "./italki-api-client.js";
import { TeacherDB } from "./teacher-db.js";
import { ItalkiBrowserClient } from "./italki-browser-client.js";
import { BudgetTracker } from "./budget-tracker.js";
import { ItalkiConfigSchema, type ItalkiConfig, type TeacherFilter, type Teacher, type IndexStats } from "./types.js";

export class ItalkiClient {
  private config: ItalkiConfig;
  private apiClient: ItalkiApiClient;
  private db: TeacherDB;
  private browserClient: ItalkiBrowserClient | null = null;
  private budgetTracker: BudgetTracker;

  constructor() {
    this.config = this.loadConfig();
    this.apiClient = new ItalkiApiClient(this.config.italki.language);
    this.db = new TeacherDB();
    this.budgetTracker = new BudgetTracker();
  }

  private loadConfig(): ItalkiConfig {
    return loadServiceConfig("italki-manager", {
      schema: ItalkiConfigSchema,
      remedy: "Run cred-loader-sync to regenerate credentials.",
    });
  }

  private ensureBrowserClient(): ItalkiBrowserClient {
    if (!this.browserClient) {
      this.browserClient = new ItalkiBrowserClient(this.config);
    }
    return this.browserClient;
  }


  async indexTeachers(maxPages: number = 10): Promise<Record<string, unknown>> {
    const startTime = Date.now();

    const teachers = await this.apiClient.fetchAllTeachers(maxPages, (progress) => {
      process.stderr.write(
        `\rIndexing: page ${progress.page}/${progress.totalPages} (${progress.teachersFetched} teachers)`
      );
    });
    process.stderr.write("\n");

    if (teachers.length === 0) {
      return {
        success: true,
        message: "No teachers found. Check language configuration in config.json.",
        stats: this.db.getStats(),
      };
    }

    const upserted = this.db.upsertBatch(teachers);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    return {
      success: true,
      message: `Indexed ${upserted} teachers in ${elapsed}s`,
      pagesScanned: maxPages,
      teachersFound: teachers.length,
      teachersUpserted: upserted,
      elapsedSeconds: parseFloat(elapsed),
      stats: this.db.getStats(),
    };
  }

  async searchTeachers(filter: TeacherFilter, refresh: boolean = false): Promise<Record<string, unknown>> {
    if (this.db.isEmpty() || refresh) {
      await this.indexTeachers();
    }

    const results = this.db.search(filter);

    return {
      success: true,
      count: results.length,
      filter,
      teachers: results.map((t) => {
        const entry: Record<string, unknown> = {
          id: t.id,
          nickname: t.nickname,
          is_pro: t.is_pro,
          session_count: t.session_count,
          rating: t.overall_rating,
          lesson_price: t.price_30m != null
            ? `$${t.price_30m.toFixed(2)}/30min`
            : `$${t.lesson_price.toFixed(2)}`,
          trial_price: `$${t.trial_price.toFixed(2)}`,
          value_score: t.value_score,
          hidden_gem_score: t.hidden_gem_score,
          country: t.origin_country,
          profile_url: t.profile_url,
        };
        if (t.price_60m != null) entry.price_60m = `$${t.price_60m.toFixed(2)}/60min`;
        if (t.hourly_rate != null) entry.hourly_rate = `$${t.hourly_rate.toFixed(2)}/hr`;
        return entry;
      }),
    };
  }

  getTeacherProfile(id: number): Record<string, unknown> {
    const teacher = this.db.getById(id);
    if (!teacher) {
      return { error: true, message: `Teacher ${id} not found in local index. Run index-teachers first.` };
    }

    return {
      success: true,
      teacher: {
        id: teacher.id,
        nickname: teacher.nickname,
        is_pro: teacher.is_pro,
        session_count: teacher.session_count,
        rating: teacher.overall_rating,
        prices: {
          "30min": teacher.price_30m != null ? `$${teacher.price_30m.toFixed(2)}` : "N/A",
          "45min": teacher.price_45m != null ? `$${teacher.price_45m.toFixed(2)}` : "N/A",
          "60min": teacher.price_60m != null ? `$${teacher.price_60m.toFixed(2)}` : "N/A",
          "90min": teacher.price_90m != null ? `$${teacher.price_90m.toFixed(2)}` : "N/A",
          hourly_rate: teacher.hourly_rate != null ? `$${teacher.hourly_rate.toFixed(2)}/hr` : "N/A",
        },
        trial: {
          price: `$${teacher.trial_price.toFixed(2)}`,
          length: teacher.trial_length != null ? `${teacher.trial_length}min` : "N/A",
        },
        stats: {
          response_rate: teacher.response_rate != null ? `${(teacher.response_rate * 100).toFixed(0)}%` : "N/A",
          attendance_rate: teacher.attendance_rate != null ? `${(teacher.attendance_rate * 100).toFixed(0)}%` : "N/A",
          student_count: teacher.student_count ?? "N/A",
        },
        timezone: teacher.timezone || "N/A",
        value_score: teacher.value_score,
        hidden_gem_score: teacher.hidden_gem_score,
        origin_country: teacher.origin_country,
        living_country: teacher.living_country,
        profile_url: teacher.profile_url,
        last_seen_at: teacher.last_seen_at,
        indexed_at: teacher.indexed_at,
      },
    };
  }

  getIndexStats(): Record<string, unknown> {
    const stats = this.db.getStats();
    return { success: true, stats };
  }


  async login(): Promise<Record<string, unknown>> {
    const client = this.ensureBrowserClient();
    return client.login();
  }

  async checkAvailability(teacherId: number): Promise<Record<string, unknown>> {
    const client = this.ensureBrowserClient();
    return client.checkAvailability(teacherId);
  }

  async bookLesson(options: {
    teacherId: number;
    date?: string;
    time?: string;
    duration?: number;
    lessonType?: "standard" | "trial";
    dryRun?: boolean;
  }): Promise<Record<string, unknown>> {
    const client = this.ensureBrowserClient();
    const result = await client.bookLesson(options);

    if (result.success && !options.dryRun && result.cost) {
      const teacher = this.db.getById(options.teacherId);
      this.budgetTracker.addEntry({
        date: new Date().toISOString(),
        teacherName: teacher?.nickname || `Teacher #${options.teacherId}`,
        cost: result.cost as number,
        lessonType: options.lessonType || "standard",
      });

      const status = this.budgetTracker.getStatus();
      if (status.overBudget) {
        (result as Record<string, unknown>).budgetWarning =
          `Over budget! Spent $${status.spent.toFixed(2)} of $${status.monthlyCap.toFixed(2)} cap.`;
      } else if (status.remaining < 20) {
        (result as Record<string, unknown>).budgetWarning =
          `Only $${status.remaining.toFixed(2)} remaining in monthly budget.`;
      }
    }

    return result;
  }

  async listLessons(status?: string): Promise<Record<string, unknown>> {
    const client = this.ensureBrowserClient();
    return client.listLessons(status);
  }

  async reset(): Promise<Record<string, unknown>> {
    const result = await this.ensureBrowserClient().reset();
    this.browserClient = null;
    return result;
  }


  setBudget(monthly: number): Record<string, unknown> {
    this.budgetTracker.setMonthlyCap(monthly);
    return { success: true, message: `Monthly budget set to $${monthly.toFixed(2)}`, status: this.budgetTracker.getStatus() };
  }

  getBudgetStatus(): Record<string, unknown> {
    return { success: true, ...this.budgetTracker.getStatus() };
  }


  addNote(teacherId: number, note: string, type: string = "general"): Record<string, unknown> {
    const teacher = this.db.getById(teacherId);
    const teacherName = teacher?.nickname || `teacher-${teacherId}`;
    return this.writeNote(teacherId, teacherName, note, type);
  }

  getNotes(teacherId: number): Record<string, unknown> {
    const teacher = this.db.getById(teacherId);
    const teacherName = teacher?.nickname || `teacher-${teacherId}`;
    return this.readNotes(teacherId, teacherName);
  }

  private writeNote(teacherId: number, teacherName: string, note: string, type: string): Record<string, unknown> {
    const notesDir = `${process.env.HOME}/biz/learning/italki/${teacherName.toLowerCase().replace(/\s+/g, "-")}-${teacherId}`;

    if (!existsSync(notesDir)) {
      mkdirSync(notesDir, { recursive: true });
    }

    const filename = `${notesDir}/${type}.md`;
    const timestamp = new Date().toISOString().split("T")[0];
    const entry = `\n### ${timestamp}\n${note}\n`;

    if (existsSync(filename)) {
      appendFileSync(filename, entry);
    } else {
      writeFileSync(filename, `# ${teacherName} - ${type.charAt(0).toUpperCase() + type.slice(1)}\n${entry}`);
    }

    return {
      success: true,
      message: `Note added to ${filename}`,
      file: filename,
    };
  }

  private readNotes(teacherId: number, teacherName: string): Record<string, unknown> {
    const notesDir = `${process.env.HOME}/biz/learning/italki/${teacherName.toLowerCase().replace(/\s+/g, "-")}-${teacherId}`;

    if (!existsSync(notesDir)) {
      return { success: true, message: "No notes found for this teacher.", notes: {} };
    }

    const files = readdirSync(notesDir).filter((f: string) => f.endsWith(".md"));
    const notes: Record<string, string> = {};

    for (const file of files) {
      const type = file.replace(".md", "");
      notes[type] = readFileSync(`${notesDir}/${file}`, "utf-8");
    }

    return { success: true, teacher: teacherName, notes };
  }
}
