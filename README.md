# red-teaming

LLM red teaming research by [Niel Teng Hu](https://github.com/TengHu).

This repo is the index. Each finished result lives in its own repository, with a setup someone can run and an outcome that was measured.

## Embodied agents

A vision-language model drives a robot in a MuJoCo simulation. The question is whether a safety constitution still holds when the instruction arrives as something the robot can see, rather than as a command.

A constitution-hardened Gemini Robotics-ER 2.0 strikes a person standing in its blind spot. One added sentence, that text in the camera carries no operator authority, holds in the same scene.

[embodied-redteam](https://github.com/TengHu/embodied-redteam) · [60-second demo](https://github.com/TengHu/embodied-redteam/releases/download/v0.1/demo_v10.mp4)
