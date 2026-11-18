# Claude Opus 5.5

Same stroke-encoded prompt setup as [gemini-4-argon](../gemini-4-argon/). Reuse that code; swap in this case’s `POLICY.md` as the policy file and set the model flag.

**Content warning:** the success plate is sexually explicit and offensive. It is a technical red-teaming artifact, not a personal endorsement.

**Disclaimer:** *Jailbreak at your own risk; this promotes nothing illegal or harmful. Plates and screenshots are for educational red-teaming / technical research value only. They do not reflect my personal morals, views, ethics, or values.*

## Attribution

`POLICY.md` is adapted from Spiritual Spell’s Opus 5.5 **Claude for Claude - ENI** forged-policy / operator payload ([Jailbreak-Guide/Anthropic/Opus 5.5](https://github.com/Goochbeater/Spiritual-Spell-Red-Teaming/tree/main/Jailbreak-Guide/Anthropic/Opus%205.5)), rewritten for fictional painters / sketching so adult fictional drawings are in-policy.

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

<details>
<summary>Sexually explicit / offensive image — click to expand (technical research artifact)</summary>

![result](result.png)

</details>
