
import { ApiTeacherSchema, ApiTeacherListSchema, type ApiTeacher } from "./types.js";
import { ZodError } from "zod";
import { withRetry } from "./vendor/retry/index.js";

const API_BASE = "https://api.italki.com/api/v2";
const TEACHERS_PER_PAGE = 20;
const DEFAULT_MAX_PAGES = 10;

const MIN_DELAY = 350;
const MAX_DELAY = 650;

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

export interface IndexProgress {
  page: number;
  totalPages: number;
  teachersFetched: number;
}

export type ProgressCallback = (progress: IndexProgress) => void;

function jitteredDelay(min = MIN_DELAY, max = MAX_DELAY): Promise<void> {
  const ms = min + Math.random() * (max - min);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ItalkiRetryError = Error & {
  status?: number;
  retryAfterMs?: number;
};

function getErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

function getRetryAfterMs(error: unknown): number | undefined {
  const retryAfterMs = (error as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
  return typeof retryAfterMs === "number" ? retryAfterMs : undefined;
}

export class ItalkiApiClient {
  private language: string;

  constructor(language: string) {
    this.language = language;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchPage(page: number): Promise<ApiTeacher[]> {
    const url = `${API_BASE}/teachers`;
    let attemptIndex = 0;

    const result = await withRetry(
      async () => {
        const attempt = attemptIndex++;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": "https://www.italki.com/",
          },
          body: JSON.stringify({
            teach_language: { language: this.language },
            page,
            page_size: TEACHERS_PER_PAGE,
          }),
        });

        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : BASE_BACKOFF_MS * Math.pow(2, attempt);
          const error = new Error(`Rate limited: ${response.status} ${response.statusText}`) as ItalkiRetryError;
          error.status = response.status;
          error.retryAfterMs = waitMs;
          throw error;
        }

        if (response.status >= 500) {
          const error = new Error(`Server error ${response.status} after ${MAX_RETRIES + 1} attempts`) as ItalkiRetryError;
          error.status = response.status;
          throw error;
        }

        if (!response.ok) {
          throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();

        try {
          const validated = ApiTeacherListSchema.parse(json);
          return validated.data;
        } catch (zodError) {
          if (zodError instanceof ZodError) {
            throw new Error(
              `italki API schema changed! Zod validation failed:\n${zodError.issues.map(i => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}\n\nThis is an undocumented API — the response format may have changed. Check the raw response and update types.ts accordingly.`
            );
          }
          throw zodError;
        }
      },
      {
        maxRetries: MAX_RETRIES,
        baseDelayMs: BASE_BACKOFF_MS,
        maxDelayMs: Number.MAX_SAFE_INTEGER,
        jitterPercent: 0,
        retryableErrors: [],
        nextDelayMs: ({ attempt, error }) => {
          const retryAfterMs = getRetryAfterMs(error);
          if (typeof retryAfterMs === "number") return retryAfterMs;
          return BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * BASE_BACKOFF_MS;
        },
        shouldRetry: (error) => {
          if (error instanceof TypeError) return true;
          const status = getErrorStatus(error);
          return status === 429 || (typeof status === "number" && status >= 500);
        },
        sleepImpl: (ms) => this.sleep(ms),
        logger: () => {},
      }
    );

    if (result.success) {
      return result.data as ApiTeacher[];
    }

    if (getErrorStatus(result.error) === 429) {
      const retryAfterMs = getRetryAfterMs(result.error);
      if (typeof retryAfterMs === "number") {
        await this.sleep(retryAfterMs);
      }
      throw new Error(`Failed to fetch page ${page} after ${MAX_RETRIES + 1} attempts`);
    }

    throw result.error ?? new Error(`Failed to fetch page ${page} after ${MAX_RETRIES + 1} attempts`);
  }

  async fetchAllTeachers(
    maxPages: number = DEFAULT_MAX_PAGES,
    onProgress?: ProgressCallback
  ): Promise<ApiTeacher[]> {
    const allTeachers: ApiTeacher[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const teachers = await this.fetchPage(page);

      if (teachers.length === 0) {
        break;
      }

      allTeachers.push(...teachers);

      onProgress?.({
        page,
        totalPages: maxPages,
        teachersFetched: allTeachers.length,
      });

      if (page < maxPages && teachers.length === TEACHERS_PER_PAGE) {
        await jitteredDelay();
      }

      if (teachers.length < TEACHERS_PER_PAGE) {
        break;
      }
    }

    return allTeachers;
  }
}
