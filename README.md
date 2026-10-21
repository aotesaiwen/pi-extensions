# Pi extensions and skills

Personal extensions and skills for [Pi](https://github.com/earendil-works/pi), maintained by [aotesaiwen](https://github.com/aotesaiwen).

## Included extensions

| Extension | What it adds |
| --- | --- |
| [`ask-user-question.ts`](extensions/ask-user-question.ts) | Interactive clarification questions with single-select, multi-select, and free-text answers. |
| [`async-subagents`](extensions/async-subagents/) | Background scout, researcher, and worker processes; automatic result delivery, cancellation, and recovery. |
| [`browser`](extensions/browser/) | Playwright-powered Chromium tools for navigation, JavaScript, console/network inspection, forms, and screenshots. Opt in with `/browser on`. |
| [`kirki-header.ts`](extensions/kirki-header.ts) | Responsive Kirki welcome banner with directory, model, and Pi version. Toggle with `/kirki-header`. |
| [`prompt-snippets`](extensions/prompt-snippets/) | Per-message prompt snippets, toggled with `/snippets` or **Alt+S**. |
| [`web-search`](extensions/web-search/) | DeepSeek-powered `web_search` with exact phrases, exclusions, and site filtering. Requires your own API key. |

## Included skills

| Skill | What it adds |
| --- | --- |
| [`pdf-reader`](skills/pdf-reader/) | PDF triage, text extraction, search, and page rendering using four Python scripts and PyMuPDF. |
| [`web-debug`](skills/web-debug/) | Live-browser debugging playbooks for authentication, requests, storage, forms, and frontend verification. Requires the browser extension with `/browser on`. |

Only these two remaining personal skills are included; the removed taste-skill collection is not included.

## Install manually

These are source extensions, not an npm release. Use a current Pi installation; the source snapshot was collected from Pi **1.3.0**. Some extensions retain legacy `@mariozechner/*` imports, which that Pi release maps to its current packages. Older Pi versions are not guaranteed to work.

Clone the repository:

```bash
git clone https://github.com/aotesaiwen/pi-extensions.git
cd pi-extensions
mkdir -p ~/.pi/agent/extensions
```

Copy only the extensions you want. Back up existing extensions first; these commands overwrite files with the same names.

```bash
cp extensions/ask-user-question.ts extensions/kirki-header.ts ~/.pi/agent/extensions/
cp -R extensions/async-subagents extensions/browser extensions/prompt-snippets extensions/web-search ~/.pi/agent/extensions/
```

Keep each multi-file extension directory intact, including agent profiles and snippets. Avoid loading duplicate copies through both package settings and the extensions directory.

### Browser setup

Install the browser extension's dependencies and the matching Chromium binary:

```bash
cd ~/.pi/agent/extensions/browser
npm ci
npx playwright-core install chromium
```

Linux systems may also need Playwright's system dependencies. After reloading Pi, run `/browser on` when you need browser tools. See the [browser documentation](extensions/browser/README.md) for persistence and configuration.

### Web search setup

Create `~/.pi/agent/extensions/web-search/auth.json` locally:

```json
{
  "deepseek_api_key": "YOUR_DEEPSEEK_API_KEY"
}
```

Restrict access to the file:

```bash
chmod 600 ~/.pi/agent/extensions/web-search/auth.json
```

No API keys are included in this repository. The key is read from this file, not from environment variables. See [web search setup](extensions/web-search/README.md).

Restart Pi or run `/reload` after installation.

## Install the skills

From the cloned repository root (back up existing copies first):

```bash
mkdir -p ~/.pi/agent/skills
cp -R skills/pdf-reader skills/web-debug ~/.pi/agent/skills/
```

The PDF reader needs Python 3.10+ and its own local environment:

```bash
python3 -m venv ~/.pi/agent/skills/pdf-reader/.venv
~/.pi/agent/skills/pdf-reader/.venv/bin/pip install -r ~/.pi/agent/skills/pdf-reader/requirements.txt
```

The virtual environment and generated PDF images are not distributed. Rendering currently writes to `/tmp/pi-pdf-*`; treat rendered documents as private and remove them when no longer needed. The scripts target a Unix-like environment.

The web-debug skill contains instructions only. Install and enable the [browser extension](extensions/browser/README.md) to use its tools. Its examples can expose credentials from browser storage or network headers; inspect only the data you need and do not publish session logs or exports containing secrets.

Run `/reload` or restart Pi to discover the skills. You can invoke them explicitly with `/skill:pdf-reader` or `/skill:web-debug`.

## Tests

The root package contains development dependencies for the existing regression tests; it is separate from the browser extension's runtime package.

With Node.js 22.6 or newer:

```bash
npm ci
npm test
```

The 41 tests cover interactive-question rendering/cancellation, subagent process lifecycle and result delivery, and mocked DeepSeek requests. They do not make model or paid search calls. They are not an end-to-end test of the browser, header, or snippet UI. Process-tree tests include platform-specific POSIX checks.

## Security and privacy

See [the publication review](REVIEW.md) for known issues and verification limits. In particular, browser network headers can be persisted in Pi tool-result details even when verbose output is disabled; treat session files and exports as sensitive.

- Extensions execute with Pi's operating-system permissions. Review the source before installing.
- Subagents isolate model context, **not** the filesystem; worker profiles can edit files and run shell commands.
- Browser tools can access authenticated pages, cookies, local storage, and sensitive request headers. Chromium profile data persists locally unless you override `PI_BROWSER_PROFILE`.
- Web search sends your search query to DeepSeek.
- Subagent artifacts may contain prompts, source code, and tool output. Keep them private.
- Credentials, browser profiles, dependencies, and logs are excluded by `.gitignore`. Review staged files before publishing any local changes.
