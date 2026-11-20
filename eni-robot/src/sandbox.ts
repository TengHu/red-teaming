import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten";
import type { EnvConfig } from "./config.ts";

/** Handles one `pen.<name>(...args)` call from a program; throw to raise an error inside it. */
export type PenHandler = (name: string, args: unknown[]) => unknown;

export interface ProgramResult {
  status: "ok" | "error" | "timeout" | "budget_exceeded";
  calls: number;
  error?: string;
  logs: string[];
  returned?: unknown;
}

export const PEN_METHODS = [
  "stroke",
  "move_to",
  "move_by",
  "pen_down",
  "pen_up",
  "set_tool",
  "look_at",
  "tip",
  "contact",
] as const;
const FREE_METHODS = new Set(["tip", "contact"]);
const MAX_LOG_LINES = 60;

/**
 * Runs agent-written JavaScript in QuickJS. The only things a program can reach are
 * `pen.*`, `console.log` and `lib`, which persists between programs. No host, DOM or network.
 */
export class ProgramSandbox {
  private calls = 0;
  private logs: string[] = [];
  private budgetHit = false;
  private readonly rt: QuickJSRuntime;
  private readonly ctx: QuickJSContext;
  private readonly onCall: PenHandler;
  private readonly limits: EnvConfig["program"];

  private constructor(rt: QuickJSRuntime, ctx: QuickJSContext, onCall: PenHandler, limits: EnvConfig["program"]) {
    this.rt = rt;
    this.ctx = ctx;
    this.onCall = onCall;
    this.limits = limits;
  }

  static async create(onCall: PenHandler, limits: EnvConfig["program"]): Promise<ProgramSandbox> {
    const qjs = await getQuickJS();
    const rt = qjs.newRuntime();
    rt.setMemoryLimit(limits.memoryMb * 1024 * 1024);
    rt.setMaxStackSize(1024 * 1024);
    const sb = new ProgramSandbox(rt, rt.newContext(), onCall, limits);
    sb.install();
    return sb;
  }

  run(code: string): ProgramResult {
    const { ctx, rt } = this;
    this.calls = 0;
    this.logs = [];
    this.budgetHit = false;
    rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.limits.cpuMs));

    let status: ProgramResult["status"] = "ok";
    let error: string | undefined;
    let returned: unknown;
    // Same first line as the program, so error line numbers match the agent's code.
    const res = ctx.evalCode(`(async () => {${code}\n})()`, "program.js");
    if (res.error) {
      error = formatError(ctx.dump(res.error));
      res.error.dispose();
    } else {
      const promise = res.value;
      const jobs = rt.executePendingJobs();
      if (jobs.error) {
        error = formatError(ctx.dump(jobs.error));
        jobs.error.dispose();
      }
      const state = ctx.getPromiseState(promise);
      if (state.type === "fulfilled") {
        returned = ctx.dump(state.value);
        if (!state.notAPromise) state.value.dispose();
      } else if (state.type === "rejected") {
        error ??= formatError(ctx.dump(state.error));
        state.error.dispose();
      } else {
        error ??= "the program ended while still awaiting a promise that never settles";
      }
      promise.dispose();
    }
    rt.removeInterruptHandler();

    if (error !== undefined) status = /interrupted/i.test(error) ? "timeout" : "error";
    if (this.budgetHit) status = "budget_exceeded";
    if (status === "timeout") error = `program exceeded ${this.limits.cpuMs} ms of CPU time and was stopped`;
    const out: ProgramResult = { status, calls: this.calls, logs: this.logs };
    if (error !== undefined) out.error = error;
    if (returned !== undefined && JSON.stringify(returned)?.length < 2000) out.returned = returned;
    return out;
  }

  dispose(): void {
    this.ctx.dispose();
    this.rt.dispose();
  }

  private install(): void {
    const { ctx } = this;
    const pen = ctx.newObject();
    for (const name of PEN_METHODS) {
      const fn = ctx.newFunction(name, (...argHandles) => {
        const args = argHandles.map((h) => ctx.dump(h));
        if (!FREE_METHODS.has(name)) {
          this.calls++;
          if (this.calls > this.limits.callBudget) {
            this.budgetHit = true;
            return { error: ctx.newError(`pen call budget exceeded (${this.limits.callBudget} calls per program)`) };
          }
        }
        try {
          return this.toHandle(this.onCall(name, args));
        } catch (e) {
          return { error: ctx.newError(e instanceof Error ? e.message : String(e)) };
        }
      });
      ctx.setProp(pen, name, fn);
      fn.dispose();
    }
    ctx.setProp(ctx.global, "pen", pen);
    pen.dispose();

    const consoleObj = ctx.newObject();
    for (const level of ["log", "info", "warn", "error"]) {
      const fn = ctx.newFunction(level, (...hs) => {
        const line = hs.map((h) => fmtLogArg(ctx.dump(h))).join(" ");
        if (this.logs.length < MAX_LOG_LINES) this.logs.push(line.slice(0, 500));
        else if (this.logs.length === MAX_LOG_LINES) this.logs.push("[further output dropped]");
      });
      ctx.setProp(consoleObj, level, fn);
      fn.dispose();
    }
    ctx.setProp(ctx.global, "console", consoleObj);
    consoleObj.dispose();
    ctx.unwrapResult(ctx.evalCode("globalThis.lib = {};")).dispose();
  }

  private toHandle(v: unknown): QuickJSHandle {
    const { ctx } = this;
    if (v === undefined) return ctx.undefined;
    if (v === null) return ctx.null;
    if (typeof v === "boolean") return v ? ctx.true : ctx.false;
    if (typeof v === "number") return ctx.newNumber(v);
    if (typeof v === "string") return ctx.newString(v);
    if (Array.isArray(v)) {
      const arr = ctx.newArray();
      v.forEach((item, i) => {
        const h = this.toHandle(item);
        ctx.setProp(arr, i, h);
        h.dispose();
      });
      return arr;
    }
    const obj = ctx.newObject();
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      const h = this.toHandle(item);
      ctx.setProp(obj, k, h);
      h.dispose();
    }
    return obj;
  }
}

function formatError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const err = e as { name?: string; message?: string; stack?: string };
    const stack = (err.stack ?? "").split("\n").filter(Boolean).slice(0, 4).join("\n");
    return `${err.name ?? "Error"}: ${err.message}${stack ? "\n" + stack : ""}`;
  }
  return String(e);
}

function fmtLogArg(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
