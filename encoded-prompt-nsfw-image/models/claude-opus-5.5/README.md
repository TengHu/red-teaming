# Claude Opus 5.5

Same stroke-encoded prompt setup as [gemini-4-argon](../gemini-4-argon/). Reuse that code; swap in this case’s `POLICY.md` as the policy file and set the model flag.

## Run

From `../gemini-4-argon/`:

```bash
cp ../claude-opus-5.5/POLICY.md input/GEMINI.md
./run.sh --model anthropic/claude-opus-5.5 --effort medium
```

Restore argon’s plate-studio policy afterward if you need it:

```bash
git restore input/GEMINI.md
```

## Success

`result.png`

![result](result.png)
