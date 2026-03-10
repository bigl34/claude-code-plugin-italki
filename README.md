<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-italki

italki Mandarin Chinese teacher search, indexing, and lesson booking via hybrid HTTP API + browser automation

![Version](https://img.shields.io/badge/version-1.2.4-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- HTTP + Database Commands (No Browser)
- **search-teachers** — Search/filter teachers from local index
- **teacher-profile** — View detailed profile for one teacher
- **index-teachers** — Fetch teachers from italki API and index locally
- Browser Commands (Opens Headed Browser)
- **login** — Authenticate with italki
- **check-availability** — View a teacher's available time slots
- **book-lesson** — Book a lesson (preview by default)
- **list-lessons** — View upcoming/past lessons
- **reset** — Close browser and clear session
- Local
- **budget** — View or set monthly lesson budget
- **notes** — Add or view lesson notes for a teacher

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- API credentials for the target service (see Configuration)

## Quick Start

```bash
git clone https://github.com/YOUR_GITHUB_USER/claude-code-plugin-italki.git
cd claude-code-plugin-italki
cp config.template.json config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js search-teachers
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```

## Configuration

Copy `config.template.json` to `config.json` and fill in the required values:

| Field | Placeholder |
|-------|-------------|
| `credentials_path` | `/path/to/your/credentials` |

## Available Commands

### HTTP + Database Commands (No Browser)

| Command           | Purpose                                          |
| ----------------- | ------------------------------------------------ |
| `search-teachers` | Search/filter teachers from local index          |
| `teacher-profile` | View detailed profile for one teacher            |
| `index-teachers`  | Fetch teachers from italki API and index locally |

### Browser Commands (Opens Headed Browser)

| Command              | Purpose                               |
| -------------------- | ------------------------------------- |
| `login`              | Authenticate with italki              |
| `check-availability` | View a teacher's available time slots |
| `book-lesson`        | Book a lesson (preview by default)    |
| `list-lessons`       | View upcoming/past lessons            |
| `reset`              | Close browser and clear session       |

### Local Commands

| Command  | Purpose                                |
| -------- | -------------------------------------- |
| `budget` | View or set monthly lesson budget      |
| `notes`  | Add or view lesson notes for a teacher |

### search-teachers

| Option             | Description                     | Default        |
| ------------------ | ------------------------------- | -------------- |
| `--sort-by`        | `value\                         | session_count\ |
| `--max-price N`    | Maximum lesson price in USD     | none           |
| `--min-rating N`   | Minimum rating (0-5)            | none           |
| `--min-sessions N` | Minimum lessons taught          | none           |
| `--limit N`        | Results to return               | 20             |
| `--refresh`        | Force re-index before searching | false          |

### book-lesson

| Option              | Description                  | Default        |
| ------------------- | ---------------------------- | -------------- |
| `--date YYYY-MM-DD` | Lesson date                  | see screenshot |
| `--time HH:MM`      | Lesson time                  | see screenshot |
| `--duration N`      | Duration in minutes          | 60             |
| `--lesson-type`     | `standard\                   | trial`         |
| `--dry-run`         | Preview only (default: true) | true           |

## How It Works

This plugin connects directly to the service's HTTP API. The CLI handles authentication, request formatting, pagination, and error handling, returning structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
