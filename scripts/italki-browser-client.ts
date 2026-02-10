/**
 * italki Browser Client
 *
 * Playwright automation for authenticated italki actions:
 * - Login with session persistence (storageState)
 * - Check teacher availability
 * - Book lessons (two-stage: preview → confirm)
 * - List upcoming/past lessons
 *
 * Uses playwright-extra with stealth plugin for bot evasion.
 * Payment is ALWAYS manual — screenshot payment page for user.
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser, Page, BrowserContext } from "playwright";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import type { ItalkiConfig, SessionInfo } from "./types.js";

// Stealth plugin
chromium.use(StealthPlugin());

// Paths
const STORAGE_STATE_PATH = "/tmp/italki-storage-state.json";
const SCREENSHOT_DIR = "/home/USER/biz/.playwright-mcp";

// italki URLs
const ITALKI_LOGIN_URL = "https://www.italki.com/en/login";
const ITALKI_DASHBOARD_URL = "https://www.italki.com/en/dashboard";

export class ItalkiBrowserClient {
  private config: ItalkiConfig;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(config: ItalkiConfig) {
    this.config = config;
    if (!existsSync(SCREENSHOT_DIR)) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
  }

  // ============================================
  // Browser Management
  // ============================================

  private async ensureBrowser(): Promise<Page> {
    if (this.page) return this.page;

    // Launch browser with stealth
    this.browser = await chromium.launch({
      headless: false,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
      ],
    });

    // Restore session if available
    const contextOptions: Record<string, unknown> = {
      viewport: { width: 1280, height: 800 },
    };
    if (existsSync(STORAGE_STATE_PATH)) {
      try {
        contextOptions.storageState = STORAGE_STATE_PATH;
      } catch {
        // Invalid storage state — start fresh
      }
    }

    this.context = await this.browser.newContext(contextOptions);
    this.page = await this.context.newPage();

    return this.page;
  }

  private async saveSession(): Promise<void> {
    if (this.context) {
      try {
        await this.context.storageState({ path: STORAGE_STATE_PATH });
      } catch {
        // Ignore save errors
      }
    }
  }

  private async screenshot(name: string): Promise<string> {
    const path = `${SCREENSHOT_DIR}/italki-${name}-${Date.now()}.png`;
    if (this.page) {
      await this.page.screenshot({ path, fullPage: true });
    }
    return path;
  }

  private async dismissCookieBanners(page: Page): Promise<void> {
    await page.waitForTimeout(2000);

    // Try clicking common cookie accept buttons
    const selectors = [
      'button:has-text("Accept All")',
      'button:has-text("Accept")',
      'button:has-text("Got it")',
      'button:has-text("I Agree")',
      '[id*="accept"]',
    ];

    for (const selector of selectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          await button.click({ force: true, timeout: 3000 });
          await page.waitForTimeout(500);
          break;
        }
      } catch {
        continue;
      }
    }
  }

  // ============================================
  // Login
  // ============================================

  async login(): Promise<Record<string, unknown>> {
    const page = await this.ensureBrowser();

    // Check if already logged in by visiting dashboard
    try {
      await page.goto(ITALKI_DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);

      const url = page.url();
      if (url.includes("dashboard") && !url.includes("login")) {
        await this.saveSession();
        return {
          success: true,
          message: "Already logged in (session restored from storageState).",
          screenshot: await this.screenshot("dashboard"),
        };
      }
    } catch {
      // Not logged in — proceed to login
    }

    // Navigate to login page
    await page.goto(ITALKI_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await this.dismissCookieBanners(page);

    const loginScreenshot = await this.screenshot("login-page");

    // Find and fill email field
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[placeholder*="email" i]',
      'input[id*="email" i]',
    ];

    let emailField = null;
    for (const selector of emailSelectors) {
      try {
        emailField = await page.waitForSelector(selector, { timeout: 5000 });
        if (emailField) break;
      } catch {
        continue;
      }
    }

    if (!emailField) {
      const errorScreenshot = await this.screenshot("login-error-no-email");
      return {
        error: true,
        message: `Could not find email field. See screenshot: ${errorScreenshot}`,
        screenshot: errorScreenshot,
      };
    }

    await emailField.fill(this.config.italki.email);

    // Find and fill password field
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[placeholder*="password" i]',
    ];

    let passwordField = null;
    for (const selector of passwordSelectors) {
      try {
        passwordField = await page.waitForSelector(selector, { timeout: 5000 });
        if (passwordField) break;
      } catch {
        continue;
      }
    }

    if (!passwordField) {
      const errorScreenshot = await this.screenshot("login-error-no-password");
      return {
        error: true,
        message: `Could not find password field. See screenshot: ${errorScreenshot}`,
        screenshot: errorScreenshot,
      };
    }

    await passwordField.fill(this.config.italki.password);

    // Click login button
    const loginButtonSelectors = [
      'button[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
    ];

    for (const selector of loginButtonSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          await button.click({ force: true });
          break;
        }
      } catch {
        continue;
      }
    }

    // Wait for login result
    try {
      await page.waitForURL(/dashboard|student/i, { timeout: 30000 });
      await page.waitForTimeout(2000);

      await this.saveSession();

      return {
        success: true,
        message: "Logged in successfully.",
        screenshot: await this.screenshot("logged-in"),
      };
    } catch {
      // Check for CAPTCHA
      const pageContent = await page.content();
      if (pageContent.includes("captcha") || pageContent.includes("recaptcha") || pageContent.includes("hCaptcha")) {
        const captchaScreenshot = await this.screenshot("captcha");
        return {
          error: true,
          message: `CAPTCHA detected. Please solve it in the visible browser window, then run login again. Screenshot: ${captchaScreenshot}`,
          screenshot: captchaScreenshot,
          captchaDetected: true,
        };
      }

      const errorScreenshot = await this.screenshot("login-failed");
      return {
        error: true,
        message: `Login failed. Check credentials and see screenshot: ${errorScreenshot}`,
        screenshot: errorScreenshot,
      };
    }
  }

  // ============================================
  // Availability
  // ============================================

  async checkAvailability(teacherId: number): Promise<Record<string, unknown>> {
    const page = await this.ensureBrowser();

    // Ensure logged in
    const loginResult = await this.login();
    if ((loginResult as Record<string, unknown>).error) {
      return loginResult;
    }

    const teacherUrl = `https://www.italki.com/en/teacher/${teacherId}/schedule`;
    await page.goto(teacherUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    const screenshotPath = await this.screenshot("availability");

    // Try to extract available slots from the page
    try {
      const slots = await page.evaluate(() => {
        const slotElements = document.querySelectorAll('[class*="time-slot"], [class*="available"], [data-time]');
        const results: Array<{ date: string; time: string; available: boolean }> = [];

        slotElements.forEach((el) => {
          const text = el.textContent?.trim() || "";
          const dataTime = el.getAttribute("data-time") || "";
          if (text || dataTime) {
            results.push({
              date: dataTime.split("T")[0] || "",
              time: dataTime.split("T")[1]?.substring(0, 5) || text,
              available: !el.classList.toString().includes("disabled") && !el.classList.toString().includes("unavailable"),
            });
          }
        });

        return results;
      });

      return {
        success: true,
        teacherId,
        teacherUrl,
        slots: slots.length > 0 ? slots : "Slots could not be parsed automatically — check the screenshot.",
        screenshot: screenshotPath,
        message: slots.length > 0
          ? `Found ${slots.filter((s: { available: boolean }) => s.available).length} available slots.`
          : "Could not parse slots automatically. Review the screenshot.",
      };
    } catch {
      return {
        success: true,
        teacherId,
        teacherUrl,
        message: "Availability page loaded. Review the screenshot to see available slots.",
        screenshot: screenshotPath,
      };
    }
  }

  // ============================================
  // Booking
  // ============================================

  async bookLesson(options: {
    teacherId: number;
    date?: string;
    time?: string;
    duration?: number;
    lessonType?: "standard" | "trial";
    dryRun?: boolean;
  }): Promise<Record<string, unknown>> {
    const page = await this.ensureBrowser();
    const dryRun = options.dryRun !== false; // Default true

    // Ensure logged in
    const loginResult = await this.login();
    if ((loginResult as Record<string, unknown>).error) {
      return loginResult;
    }

    // Navigate to teacher's booking page
    const teacherUrl = `https://www.italki.com/en/teacher/${options.teacherId}`;
    await page.goto(teacherUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Look for "Book lesson" or "Book trial" button
    const buttonText = options.lessonType === "trial" ? "trial" : "lesson";
    const bookButtonSelectors = [
      `button:has-text("Book ${buttonText}")`,
      `button:has-text("Book a ${buttonText}")`,
      'button:has-text("Book")',
      '[class*="book-button"]',
      '[data-testid*="book"]',
    ];

    let clicked = false;
    for (const selector of bookButtonSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          await button.click({ force: true });
          clicked = true;
          await page.waitForTimeout(2000);
          break;
        }
      } catch {
        continue;
      }
    }

    if (!clicked) {
      const errorScreenshot = await this.screenshot("book-error-no-button");
      return {
        error: true,
        message: `Could not find booking button. See screenshot: ${errorScreenshot}`,
        screenshot: errorScreenshot,
      };
    }

    // Select date if provided
    if (options.date) {
      try {
        // Look for date picker and select the date
        const dateElements = await page.$$('[class*="calendar"] [class*="day"], [class*="date-picker"] button');
        const dayNum = new Date(options.date).getDate();
        for (const el of dateElements) {
          const text = await el.textContent();
          if (text?.trim() === String(dayNum)) {
            await el.click();
            await page.waitForTimeout(1000);
            break;
          }
        }
      } catch {
        // Date selection failed — continue, user can see in screenshot
      }
    }

    // Select time if provided
    if (options.time) {
      try {
        const timeSlots = await page.$$('[class*="time-slot"], [class*="slot"]');
        for (const slot of timeSlots) {
          const text = await slot.textContent();
          if (text?.includes(options.time)) {
            await slot.click();
            await page.waitForTimeout(1000);
            break;
          }
        }
      } catch {
        // Time selection failed
      }
    }

    // Take preview screenshot (Stage 1)
    const previewScreenshot = await this.screenshot("booking-preview");

    // Determine booking type from page
    const pageContent = await page.content();
    const isInstant = pageContent.toLowerCase().includes("instant") && !pageContent.toLowerCase().includes("request");
    const bookingType = isInstant ? "instant" : "request";

    // Extract cost from page if visible
    let cost = 0;
    try {
      const costText = await page.evaluate(() => {
        const priceEl = document.querySelector('[class*="price"], [class*="cost"], [class*="total"]');
        return priceEl?.textContent || "";
      });
      const costMatch = costText.match(/[\$]?([\d.]+)/);
      if (costMatch) cost = parseFloat(costMatch[1]);
    } catch {
      // Cost extraction failed
    }

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        teacherId: options.teacherId,
        lessonType: options.lessonType || "standard",
        date: options.date || "see screenshot",
        time: options.time || "see screenshot",
        bookingType,
        estimatedCost: cost > 0 ? `$${cost.toFixed(2)}` : "see screenshot",
        screenshot: previewScreenshot,
        message: "Booking preview (dry run). Review the screenshot. To submit, run book-lesson with --dry-run=false",
      };
    }

    // Stage 2: Actually submit
    const confirmSelectors = [
      'button:has-text("Confirm")',
      'button:has-text("Book now")',
      'button:has-text("Submit")',
      'button:has-text("Pay")',
      'button[type="submit"]',
    ];

    clicked = false;
    for (const selector of confirmSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          await button.click({ force: true });
          clicked = true;
          await page.waitForTimeout(3000);
          break;
        }
      } catch {
        continue;
      }
    }

    // Check if payment page appeared
    const currentUrl = page.url();
    if (currentUrl.includes("pay") || currentUrl.includes("checkout")) {
      const paymentScreenshot = await this.screenshot("payment-page");
      return {
        success: true,
        paymentRequired: true,
        teacherId: options.teacherId,
        bookingType,
        cost: cost > 0 ? cost : undefined,
        screenshot: paymentScreenshot,
        message: "Payment page reached. Please complete payment manually in the visible browser window. DO NOT close the browser.",
      };
    }

    // Take confirmation screenshot
    const confirmScreenshot = await this.screenshot("booking-confirmed");

    return {
      success: true,
      teacherId: options.teacherId,
      lessonType: options.lessonType || "standard",
      date: options.date,
      time: options.time,
      bookingType,
      cost: cost > 0 ? cost : undefined,
      screenshot: confirmScreenshot,
      message: bookingType === "instant"
        ? "Lesson booked successfully!"
        : "Booking request sent. Teacher must approve. Check your italki dashboard for confirmation.",
    };
  }

  // ============================================
  // List Lessons
  // ============================================

  async listLessons(statusFilter?: string): Promise<Record<string, unknown>> {
    const page = await this.ensureBrowser();

    const loginResult = await this.login();
    if ((loginResult as Record<string, unknown>).error) {
      return loginResult;
    }

    // Navigate to lessons page
    await page.goto("https://www.italki.com/en/student/lessons", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    const screenshotPath = await this.screenshot("lessons-list");

    // Try to extract lesson info from page
    try {
      const lessons = await page.evaluate(() => {
        const lessonCards = document.querySelectorAll('[class*="lesson-card"], [class*="lesson-item"], [class*="session"]');
        const results: Array<{
          teacherName: string;
          date: string;
          time: string;
          status: string;
          type: string;
        }> = [];

        lessonCards.forEach((card) => {
          const text = card.textContent || "";
          results.push({
            teacherName: card.querySelector('[class*="teacher-name"], [class*="name"]')?.textContent?.trim() || "Unknown",
            date: card.querySelector('[class*="date"]')?.textContent?.trim() || "",
            time: card.querySelector('[class*="time"]')?.textContent?.trim() || "",
            status: card.querySelector('[class*="status"]')?.textContent?.trim() || "",
            type: card.querySelector('[class*="type"]')?.textContent?.trim() || "",
          });
        });

        return results;
      });

      const filtered = statusFilter && statusFilter !== "all"
        ? lessons.filter((l: { status: string }) => l.status.toLowerCase().includes(statusFilter.toLowerCase()))
        : lessons;

      return {
        success: true,
        count: filtered.length,
        lessons: filtered,
        screenshot: screenshotPath,
        message: filtered.length > 0
          ? `Found ${filtered.length} lesson(s).`
          : "No lessons found. Check the screenshot for details.",
      };
    } catch {
      return {
        success: true,
        message: "Lessons page loaded. Review the screenshot.",
        screenshot: screenshotPath,
      };
    }
  }

  // ============================================
  // Session Management
  // ============================================

  async reset(): Promise<Record<string, unknown>> {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.context = null;
        this.page = null;
      }

      if (existsSync(STORAGE_STATE_PATH)) {
        unlinkSync(STORAGE_STATE_PATH);
      }

      return {
        success: true,
        message: "Browser session closed and storage state cleared.",
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        error: true,
        message: `Reset failed: ${message}`,
      };
    }
  }
}
