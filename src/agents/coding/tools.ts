import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, dirname } from "node:path";
import type { ToolSpec } from "../../llm/provider.ts";

/**
 * The coding agent's tools, the way Claude Code exposes Read/Grep/Edit/Write/Bash.
 *
 * Every tool operates inside one repository root and refuses to touch anything
 * outside it. That boundary is the whole safety model at this layer: the agent
 * runs with bypass-permissions inside a git checkpoint the loop can hard-reset,
 * so the one thing that must never happen is a write escaping the repo. Reads
 * are bounded too, because an agent that cats a 5MB bundle burns the context
 * window for nothing.
 */

export interface ToolContext {
  repoPath: string;
  /** Files read this session, so the agent (and the loop) can see what it looked at. */
  filesRead: Set<string>;
  /** Files written this session. */
  filesWritten: Set<string>;
  onEvent?: (line: string) => void;
}

/** Resolve a repo-relative path and refuse anything that escapes the root. */
function safeResolve(ctx: ToolContext, path: string): string {
  const target = resolve(ctx.repoPath, path);
  const rel = relative(ctx.repoPath, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path '${path}' is outside the repository and cannot be accessed`);
  }
  return target;
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List the repository's source files (respects .gitignore). Use once at the start to orient yourself.",
      parameters: {
        type: "object",
        properties: {
          glob: { type: "string", description: "Optional path substring to filter by, e.g. 'checkout'." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Search file contents across the repo for a string or regex. Returns matching file:line snippets. This is how you find where something lives.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text or regular expression to search for." },
          regex: { type: "boolean", description: "Treat query as a regex. Default false." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file's full contents, with line numbers. Read before you edit.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Repo-relative path." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact substring in a file. old_string must appear EXACTLY ONCE and match verbatim including whitespace. Prefer this over rewriting whole files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string", description: "Exact text to replace. Must be unique in the file." },
          new_string: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file or overwrite an existing one with full contents. Use for new files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "Complete file contents." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the repo (build, tests, a script) and get its output. Use it to CHECK YOUR OWN WORK before finishing. Times out after 120s.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The shell command." } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description:
        "Call this ONLY when the fix is complete and you have verified it. Provide a summary of what you changed and how you know it works.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
  },
];

/** Execute a tool call and return the text the model sees as the result. */
export function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list_files":
      return listFiles(ctx, typeof args["glob"] === "string" ? args["glob"] : undefined);
    case "search":
      return search(ctx, String(args["query"] ?? ""), Boolean(args["regex"]));
    case "read_file":
      return readFile(ctx, String(args["path"] ?? ""));
    case "edit_file":
      return editFile(ctx, String(args["path"] ?? ""), String(args["old_string"] ?? ""), String(args["new_string"] ?? ""));
    case "write_file":
      return writeFile(ctx, String(args["path"] ?? ""), String(args["content"] ?? ""));
    case "run_command":
      return runCommand(ctx, String(args["command"] ?? ""));
    default:
      return `error: unknown tool '${name}'`;
  }
}

function git(ctx: ToolContext, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ctx.repoPath, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch {
    return "";
  }
}

function listFiles(ctx: ToolContext, glob?: string): string {
  let files = git(ctx, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  if (glob) files = files.filter((f) => f.includes(glob));
  if (files.length === 0) return "no files matched";
  if (files.length > 300) return files.slice(0, 300).join("\n") + `\n... (${files.length - 300} more, narrow with a glob)`;
  return files.join("\n");
}

function search(ctx: ToolContext, query: string, isRegex: boolean): string {
  if (!query) return "error: empty query";
  // git grep is fast, respects .gitignore, and is present wherever git is.
  // -I skips binaries; --untracked so a just-written file is searchable too.
  const flags = isRegex ? ["-n", "-I", "-E"] : ["-n", "-I", "-F"];
  const out = git(ctx, ["grep", ...flags, "--untracked", query]);
  if (!out) return `no matches for ${isRegex ? "regex" : "string"}: ${query}`;
  const lines = out.split("\n");
  if (lines.length > 60) return lines.slice(0, 60).join("\n") + `\n... (${lines.length - 60} more matches)`;
  return out;
}

function readFile(ctx: ToolContext, path: string): string {
  let target: string;
  try {
    target = safeResolve(ctx, path);
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : e}`;
  }
  if (!existsSync(target)) return `error: no such file: ${path}`;
  let content: string;
  try {
    content = readFileSync(target, "utf8");
  } catch (e) {
    return `error: could not read ${path}: ${e instanceof Error ? e.message : e}`;
  }
  if (content.length > 60_000) return `error: ${path} is too large to read whole (${content.length} bytes). Use search to find the relevant part.`;
  ctx.filesRead.add(path);
  return content
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(5)}  ${line}`)
    .join("\n");
}

function editFile(ctx: ToolContext, path: string, oldStr: string, newStr: string): string {
  let target: string;
  try {
    target = safeResolve(ctx, path);
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : e}`;
  }
  if (!existsSync(target)) return `error: no such file: ${path}. Use write_file to create it.`;
  const content = readFileSync(target, "utf8");
  if (oldStr === "") return "error: old_string is empty. Use write_file to overwrite a whole file.";
  const first = content.indexOf(oldStr);
  if (first === -1) return `error: old_string not found in ${path}. Read the file again; it must match exactly, including whitespace.`;
  if (content.indexOf(oldStr, first + 1) !== -1)
    return `error: old_string appears more than once in ${path}. Include more surrounding context to make it unique.`;
  writeFileSync(target, content.replace(oldStr, newStr), "utf8");
  ctx.filesWritten.add(path);
  ctx.onEvent?.(`edit ${path}`);
  return `edited ${path}`;
}

function writeFile(ctx: ToolContext, path: string, content: string): string {
  let target: string;
  try {
    target = safeResolve(ctx, path);
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : e}`;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  ctx.filesWritten.add(path);
  ctx.onEvent?.(`write ${path}`);
  return `wrote ${path} (${content.split("\n").length} lines)`;
}

function runCommand(ctx: ToolContext, command: string): string {
  if (!command) return "error: empty command";
  ctx.onEvent?.(`run: ${command}`);
  try {
    const out = execFileSync(command, {
      cwd: ctx.repoPath,
      shell: true,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const text = out.trim();
    return text ? `exit 0\n${text.slice(0, 8000)}` : "exit 0 (no output)";
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number; message?: string };
    const body = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
    return `exit ${e.status ?? "?"}\n${(body || e.message || "command failed").slice(0, 8000)}`;
  }
}
