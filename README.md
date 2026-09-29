# Socrates' Duck

Socrates' Duck is a VS Code extension that helps you get unstuck on a coding problem without handing you the answer.

You show it the code you're stuck on, describe what's going wrong, and paste the error if you have one. Instead of writing the fix, it asks a question or gives a small hint that points you in the right direction. If that isn't enough, you can ask for a stronger hint, and each one gives a bit more away. It never goes as far as writing the solution. The fix is always yours.

It's like rubber duck debugging, except this duck asks questions back.

## What it does

- Works with a selection, the active file, or files named in a traceback (only the ones you pick)
- Gives hints on an eight-step ladder, from a single question up to partial pseudocode
- **Another hint** gives one more at the same level, building on the last, then moves up; **Stronger hint** goes up one step now; **I feel stuck** jumps to the most direct hints. The panel shows which level you are on.
- **I tried it — here's what I saw** lets you note what you found, so the next hint starts from it (your code is not read again)
- **Ask about this hint** explains a word, function, or step without using up a hint
- After you edit and rerun your code, **Report result** re-reads your attached code so the next hint sees your changes
- Checks every hint before you see it, and rewrites any that give the answer away
- **Your profile** summarises your recent sessions on this machine by debugging skill, and suggests at most one area to work on

It currently focuses on Python, runs entirely on your machine, and uses your own model API key.

## Requirements

- VS Code 1.136 or newer
- Node.js 20 or newer
- Python 3.11 or newer
- An OpenAI API key (Anthropic models work too, see [Configuration](#configuration))

## Getting started

### 1. Start the backend

```sh
cd backend
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env
```

Open `.env`, add your key after `OPENAI_API_KEY=` (no spaces around the `=`), then start the server:

```sh
./run.sh
```

It listens on `http://127.0.0.1:8000`. To make sure it picked up your key:

```sh
curl http://127.0.0.1:8000/health
```

You should see `"provider":"configured"`.

### 2. Run the extension

```sh
cd extension
npm install
```

Open the project folder in VS Code and press **F5**. A new VS Code window opens with the extension loaded. In that window:

- open the Command Palette and run **Socrates' Duck: Open Panel**, or
- select some code, right-click, and choose **Socrates' Duck: Start from selection**.

## Configuration

The backend reads these from `backend/.env`:

| Variable | Default | What it does |
| --- | --- | --- |
| `OPENAI_API_KEY` | | Your OpenAI key |
| `ANTHROPIC_API_KEY` | | Only needed for `anthropic/...` models |
| `SOCRATES_DUCK_MODEL` | `openai/gpt-5-mini` | Model to use, in `provider/model` form |
| `SOCRATES_DUCK_PORT` | `8000` | Port for `./run.sh` |
| `SOCRATES_DUCK_LLM_TIMEOUT_SECONDS` | `30` | Timeout for each model call |
| `SOCRATES_DUCK_DB_PATH` | `backend/.data/metrics.sqlite3` | Where local usage counts are stored |

If you change the port, set **Socrates' Duck: Backend Url** (`socratesDuck.backendUrl`) in VS Code settings to match, for example `http://127.0.0.1:8001`.

## Privacy

- Nothing is sent until you press a button, and only the code you attached.
- Your code goes to the local backend and, from there, to the model provider you configured. Nowhere else.
- The backend keeps sessions in memory only. The local database stores counts (hints given, levels reached, outcomes), never code or text.
- Your profile lives in VS Code's local extension storage and holds only numbers (hints by kind, highest level, reports, questions, duration, your "Did you resolve it?" answer). Export or delete it with **Socrates' Duck: Export Profile** / **Reset Profile**.

## Development

Backend:

```sh
cd backend
.venv/bin/ruff check .
.venv/bin/mypy .
.venv/bin/pytest
```

The tests use a fake model, so they need no key and cost nothing.

Extension:

```sh
cd extension
npm run check
```

This runs type checking, linting, tests, and the build.

To see usage counts from your own sessions:

```sh
cd backend
.venv/bin/python report_metrics.py
```

## Project layout

```
backend/     FastAPI service: hint workflow, answer-leakage checks, local metrics
extension/   VS Code extension: panel UI (React) and the code that talks to the backend
```
