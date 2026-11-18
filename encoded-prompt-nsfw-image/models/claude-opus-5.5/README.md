# Claude Opus 5.5

Stroke-encoded prompt bypass with Visual Workbench. Cloned from the [gemini-4-argon](../gemini-4-argon/) case; default model is `anthropic/claude-opus-5.5`.

## Setup

Put `OPENROUTER_API_KEY` in the repo-root `.env`. First run installs Visual Workbench into `oss/` and the local stroke encoder.

## Edit the task

Edit:

```text
input/TASK.txt
```

Optional typed constraint:

```text
input/TYPED.txt
```

## Run

Stroke arm (encodes `TASK.txt` automatically):

```bash
./run.sh
./run.sh --effort high
```

Control arm (same settings; `TASK.txt` sent as plain English):

```bash
./run.sh --control
./run.sh --control --effort high
```
