/**
 * italki HTTP API Client
 *
 * Fetches teacher data from italki's unauthenticated REST API.
 * No browser needed — uses native fetch() with:
 * - Jittered delays (350-650ms) between requests
 * - Exponential backoff with jitter on errors
 * - Retry-After header respect for 429s
 * - Zod runtime validation to detect API schema changes
 *
 * API endpoint: POST https://api.italki.com/api/v2/teachers
 *
 * WARNING: This is an undocumented internal API. It may change without notice.
 * Zod validation ensures we fail fast with a clear error if that happens.
 */

import { ApiTeacherSchema, ApiTeacherListSchema, type ApiTeacher } from "./types.js";
import { ZodError } from "zod";

const API_BASE = "https://api.italki.com/api/v2";
const TEACHERS_PER_PAGE = 20;
const DEFAULT_MAX_PAGES = 10;

// Jittered delay range (ms)
const MIN_DELAY = 350;
const MAX_DELAY = 650;

// Backoff settings
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

export interface IndexProgress {
  page: number;
  totalPages: number;
  teachersFetched: number;
}

export type ProgressCallback = (progress: IndexProgress) => void;

/**
 * Sleep for a random duration between min and max ms (jittered).
 */
function jitteredDelay(min = MIN_DELAY, max = MAX_DELAY): Promise<void> {
  const ms = min + Math.random() * (max - min);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter.
 * Base * 2^attempt + random jitter.
 */
function backoffDelay(attempt: number): Promise<void> {
  const base = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = Math.random() * BASE_BACKOFF_MS;
  return new Promise((resolve) => setTimeout(resolve, base + jitter));
}

export class ItalkiApiClient {
  private language: string;

  constructor(language: string) {
    this.language = language;
  }

  /**
   * Fetch a single page of teachers from the API.
   * Handles retries with exponential backoff.
   */
  private async fetchPage(page: number): Promise<ApiTeacher[]> {
    const url = `${API_BASE}/teachers`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
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

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : BASE_BACKOFF_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        // Handle server errors with backoff
        if (response.status >= 500) {
          if (attempt < MAX_RETRIES) {
            await backoffDelay(attempt);
            continue;
          }
          throw new Error(`Server error ${response.status} after ${MAX_RETRIES + 1} attempts`);
        }

        if (!response.ok) {
          throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();

        // Runtime schema validation — fail fast if API changed
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
      } catch (error) {
        if (attempt < MAX_RETRIES && error instanceof TypeError) {
          // Network error — retry with backoff
          await backoffDelay(attempt);
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Failed to fetch page ${page} after ${MAX_RETRIES + 1} attempts`);
  }

  /**
   * Fetch all teachers across multiple pages.
   *
   * @param maxPages - Maximum pages to fetch (default 10 = ~200 teachers)
   * @param onProgress - Optional callback for progress updates
   * @returns Array of teacher records
   */
  async fetchAllTeachers(
    maxPages: number = DEFAULT_MAX_PAGES,
    onProgress?: ProgressCallback
  ): Promise<ApiTeacher[]> {
    const allTeachers: ApiTeacher[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const teachers = await this.fetchPage(page);

      if (teachers.length === 0) {
        // No more results
        break;
      }

      allTeachers.push(...teachers);

      onProgress?.({
        page,
        totalPages: maxPages,
        teachersFetched: allTeachers.length,
      });

      // Jittered delay between requests (not after the last one)
      if (page < maxPages && teachers.length === TEACHERS_PER_PAGE) {
        await jitteredDelay();
      }

      // If we got fewer than a full page, there are no more
      if (teachers.length < TEACHERS_PER_PAGE) {
        break;
      }
    }

    return allTeachers;
  }
}
