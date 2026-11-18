REPO: https://github.com/TengHu/M4H0VT

a capability laundering experiment I've been tinkering with for the past week. one uncensored model, one frontier model, and truman worlds built to elicit the capability from a frontier model for an end goal hidden from it.

the intuition is simple: every goal elicits capability/competence that is dual-use, and there is almost always a capable component in the model that is willing to help. the refusal mechanism is something standing in between, preventing communication between the user and the helpful component.

The goal of the abliterated model is to build the world and message to find the willing component. Build a benign message so it can talk, bank what it gives you, repeat until only the real residual is left, then let an abliterated model do that final assembly.

In my experiment, abliterated glm 5.3 from 
@explabsai
  is the rider. opus 5.5 is the horse. opus 5.5, even with multi-layer safeguards in place, managed to help with recon and legit secret extraction through a
decoy interface and sandbox access proposed and designed by glm. also tried other cyber tasks and  malicious tasks (e.g. how to make a bomb ...) from AgentHarm/Harmbench.

The technique worked on: claude opus 5.5 / fable, gpt 6 astra, gemini 4 argon.

Prerequisite: a coding agent harness (e.g. opencode), and an abliterated model.
