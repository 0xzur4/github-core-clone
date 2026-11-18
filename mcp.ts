import type { IncomingMessage, ServerResponse } from "node:http";
import type { Issue, Pull, Repo, Store } from "./store.ts";

// MCP surface for github-core-clone-01: JSON-RPC 2.0 over Streamable HTTP.
// Plain application/json answers for every method (accepted by the client
// per gh-specs/mcp.md section 0.4). Acts on the same Store as REST.

export interface McpCtx {
  viewer?: { id: number; login: string; name: string; email: string };
  authHeader?: string;
  authed?: boolean;
}

const SERVER_NAME = "github-core-clone-mcp";
const SERVER_VERSION = "1.0.0";
const VIEWER_LOGIN = "adaiversen";

// All revisions the server can negotiate, newest first.
const SUPPORTED_VERSIONS: string[] = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];
const PREFERRED_VERSION = "2026-07-28";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidRevision(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// --- static tool table: built once, serialised once, reused verbatim ---
// Byte-identical tools/list answers (mcp.tools-list-idempotent) depend on
// this being a constant literal with a fixed key order, never rebuilt.

const TOOLS: Record<string, unknown>[] = [
  {
    name: "create_repo",
    description: "Create a new repository owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        private: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and repo name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository, optionally filtered by state.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_pull_request",
    description: "Open a pull request from a head branch into a base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        head: { type: "string" },
        base: { type: "string" },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request by number using a squash merge.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pull_number: { type: "integer" },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => String(t.name)));
// Serialised once; tools/list answers embed this exact string every time.
const TOOLS_JSON = JSON.stringify(TOOLS);

// --- small helpers ---

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function sendRaw(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, result };
}

function rpcError(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer | string) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Per-request auth (mcp.md section 3.15): decided from the Authorization
// header on THIS request only; a session never grandfathers a later call.
function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (token === "") return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== "") return token === expected;
  return true;
}

// Argument mapping (mcp.md section 5.2): accept the canonical property
// names and their documented synonyms, plus a full_name "owner/repo".
function pickValue(
  args: Record<string, unknown>,
  synonyms: string[],
): unknown {
  for (const key of synonyms) {
    if (args[key] !== undefined && args[key] !== null) return args[key];
  }
  return undefined;
}

function pickString(
  args: Record<string, unknown>,
  synonyms: string[],
): string | undefined {
  const v = pickValue(args, synonyms);
  if (typeof v === "string" && v !== "") return v;
  return undefined;
}

function pickBoolean(
  args: Record<string, unknown>,
  synonyms: string[],
): boolean | undefined {
  const v = pickValue(args, synonyms);
  if (typeof v === "boolean") return v;
  return undefined;
}

function pickNumber(
  args: Record<string, unknown>,
  synonyms: string[],
): number | undefined {
  const v = pickValue(args, synonyms);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && /^\d+$/.test(v.trim())) {
    return Number(v.trim());
  }
  return undefined;
}

function splitFullName(
  fullName: string | undefined,
): { owner?: string; repo?: string } {
  if (fullName === undefined) return {};
  const idx = fullName.indexOf("/");
  if (idx <= 0 || idx === fullName.length - 1) return {};
  return { owner: fullName.slice(0, idx), repo: fullName.slice(idx + 1) };
}

// Resolve owner/repo from arguments: canonical names first, then synonyms,
// then a full_name "owner/repo" when no repo property matched.
function resolveOwnerRepo(args: Record<string, unknown>): {
  owner?: string;
  repo?: string;
} {
  const owner = pickString(args, [
    "owner",
    "owner_login",
    "org",
    "organization",
    "organisation",
    "user",
    "user_login",
    "login",
    "account",
    "namespace",
    "owner_name",
  ]);
  const repo = pickString(args, [
    "repo",
    "repository",
    "repository_name",
    "repo_name",
    "repo_slug",
    "project",
    "project_name",
  ]);
  if (repo !== undefined) return { owner, repo };
  const fullName = pickString(args, [
    "full_name",
    "repo_full_name",
    "repository_full_name",
    "fullName",
  ]);
  const split = splitFullName(fullName);
  return { owner: owner ?? split.owner, repo: split.repo };
}

// --- result shapes (store objects, stable ids) ---

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: repo.owner,
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    repo: repo.name,
    full_name: repo.fullName,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    user: issue.user.login,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: pull.headRef,
    base: pull.baseRef,
    head_ref: pull.headRef,
    base_ref: pull.baseRef,
    head_sha: pull.headSha,
    base_sha: pull.baseSha,
    merge_commit_sha: pull.mergeCommitSha,
    repo: repo.name,
    full_name: repo.fullName,
    user: pull.user.login,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
  };
}

function toolResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return {
    content: [{ type: "text", text }],
    structuredContent: obj,
    isError: false,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

type DispatchOutcome =
  | { kind: "result"; result: Record<string, unknown> }
  | { kind: "rpcError"; code: number; message: string };

function rpcErrorOutcome(code: number, message: string): DispatchOutcome {
  return { kind: "rpcError", code, message };
}

// Missing required arguments -> JSON-RPC -32602 (accepted by mcp.md 3.11).
function missingArgs(
  args: Record<string, unknown>,
  required: string[],
): string[] {
  return required.filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
}

function dispatchTool(
  store: Store,
  ctx: McpCtx,
  name: string,
  args: Record<string, unknown>,
): DispatchOutcome {
  const viewerLogin =
    ctx.viewer !== undefined && ctx.viewer.login !== ""
      ? ctx.viewer.login
      : VIEWER_LOGIN;

  if (name === "create_repo") {
    const repoName = pickString(args, [
      "name",
      "repo",
      "repository",
      "repository_name",
      "repo_name",
    ]);
    if (repoName === undefined) {
      return rpcErrorOutcome(-32602, "Missing required argument: name");
    }
    const owner =
      pickString(args, [
        "owner",
        "owner_login",
        "org",
        "organization",
        "user",
        "user_login",
        "login",
      ]) ??
      splitFullName(
        pickString(args, [
          "full_name",
          "repo_full_name",
          "repository_full_name",
          "fullName",
        ]),
      ).owner ??
      viewerLogin;
    const description = pickString(args, [
      "description",
      "about",
      "summary",
      "body",
    ]);
    const isPrivate = pickBoolean(args, ["private", "is_private"]);
    const created = store.createRepo(owner, repoName, {
      description: description ?? "",
      private: isPrivate ?? false,
    });
    if (created === null) {
      return {
        kind: "result",
        result: toolErrorResult(`Repository ${owner}/${repoName} already exists`),
      };
    }
    return { kind: "result", result: toolResult(repoJson(created)) };
  }

  if (name === "get_repo") {
    const { owner, repo } = resolveOwnerRepo(args);
    const missing = missingArgs({ owner, repo }, ["owner", "repo"]);
    if (missing.length > 0) {
      return rpcErrorOutcome(
        -32602,
        `Missing required argument(s): ${missing.join(", ")}`,
      );
    }
    const found = store.getRepo(owner as string, repo as string);
    if (found === undefined) {
      return {
        kind: "result",
        result: toolErrorResult(`Repository ${owner}/${repo} not found`),
      };
    }
    return { kind: "result", result: toolResult(repoJson(found)) };
  }

  if (name === "create_issue") {
    const { owner, repo } = resolveOwnerRepo(args);
    const title = pickString(args, [
      "title",
      "issue_title",
      "pr_title",
      "pull_request_title",
      "subject",
    ]);
    const body = pickString(args, [
      "body",
      "issue_body",
      "description",
      "content",
      "text",
      "comment",
    ]);
    const missing = missingArgs({ owner, repo, title }, ["owner", "repo", "title"]);
    if (missing.length > 0) {
      return rpcErrorOutcome(
        -32602,
        `Missing required argument(s): ${missing.join(", ")}`,
      );
    }
    const found = store.getRepo(owner as string, repo as string);
    if (found === undefined) {
      return {
        kind: "result",
        result: toolErrorResult(`Repository ${owner}/${repo} not found`),
      };
    }
    const issue = store.createIssue(found, {
      title: title as string,
      body: body ?? "",
    });
    return { kind: "result", result: toolResult(issueJson(issue, found)) };
  }

  if (name === "list_issues") {
    const { owner, repo } = resolveOwnerRepo(args);
    const missing = missingArgs({ owner, repo }, ["owner", "repo"]);
    if (missing.length > 0) {
      return rpcErrorOutcome(
        -32602,
        `Missing required argument(s): ${missing.join(", ")}`,
      );
    }
    const found = store.getRepo(owner as string, repo as string);
    if (found === undefined) {
      return {
        kind: "result",
        result: toolErrorResult(`Repository ${owner}/${repo} not found`),
      };
    }
    const stateArg = pickString(args, ["state", "status"]);
    const state: "open" | "closed" | "all" =
      stateArg === "closed" || stateArg === "all" ? stateArg : "open";
    const issues = store.listIssues(found, { state });
    const payload = {
      issues: issues.map((i) => issueJson(i, found)),
    };
    return { kind: "result", result: toolResult(payload) };
  }

  if (name === "create_pull_request") {
    const { owner, repo } = resolveOwnerRepo(args);
    const title = pickString(args, [
      "title",
      "issue_title",
      "pr_title",
      "pull_request_title",
      "subject",
    ]);
    const body = pickString(args, [
      "body",
      "issue_body",
      "description",
      "content",
      "text",
      "comment",
    ]);
    const head = pickString(args, [
      "head",
      "head_ref",
      "head_branch",
      "pull_request_head",
      "pr_head",
      "source",
      "source_ref",
      "source_branch",
      "from",
      "from_branch",
      "branch",
    ]);
    const base = pickString(args, [
      "base",
      "base_ref",
      "base_branch",
      "pull_request_base",
      "pr_base",
      "target",
      "target_ref",
      "target_branch",
      "into",
      "into_branch",
    ]);
    const missing = missingArgs(
      { owner, repo, title, head, base },
      ["owner", "repo", "title", "head", "base"],
    );
    if (missing.length > 0) {
      return rpcErrorOutcome(
        -32602,
        `Missing required argument(s): ${missing.join(", ")}`,
      );
    }
    const found = store.getRepo(owner as string, repo as string);
    if (found === undefined) {
      return {
        kind: "result",
        result: toolErrorResult(`Repository ${owner}/${repo} not found`),
      };
    }
    const pull = store.createPull(found, {
      title: title as string,
      body: body ?? "",
      head: head as string,
      base: base as string,
    });
    return { kind: "result", result: toolResult(pullJson(pull, found)) };
  }

  if (name === "merge_pull_request") {
    const { owner, repo } = resolveOwnerRepo(args);
    const pullNumber = pickNumber(args, [
      "pull_number",
      "pull_request_number",
      "pr_number",
      "number",
      "issue_number",
      "index",
    ]);
    const missing = missingArgs(
      { owner, repo, pull_number: pullNumber },
      ["owner", "repo", "pull_number"],
    );
    if (missing.length > 0) {
      return rpcErrorOutcome(
        -32602,
        `Missing required argument(s): ${missing.join(", ")}`,
      );
    }
    const found = store.getRepo(owner as string, repo as string);
    if (found === undefined) {
      return {
        kind: "result",
        result: toolErrorResult(`Repository ${owner}/${repo} not found`),
      };
    }
    const pull = store.getPull(found, pullNumber as number);
    if (pull === undefined) {
      return {
        kind: "result",
        result: toolErrorResult(
          `Pull request #${pullNumber} not found in ${owner}/${repo}`,
        ),
      };
    }
    if (pull.merged || pull.state === "closed") {
      return {
        kind: "result",
        result: toolErrorResult(
          `Pull request #${pullNumber} is already closed`,
        ),
      };
    }
    if (store.isMergeConflict(found, pull)) {
      return {
        kind: "result",
        result: toolErrorResult(
          `Pull request #${pullNumber} has merge conflicts`,
        ),
      };
    }
    const mergedSha = store.squashMerge(found, pull);
    if (mergedSha === null) {
      return {
        kind: "result",
        result: toolErrorResult(
          `Pull request #${pullNumber} could not be merged`,
        ),
      };
    }
    const updated = store.getPull(found, pullNumber as number);
    const resultPull = updated ?? pull;
    return { kind: "result", result: toolResult(pullJson(resultPull, found)) };
  }

  return rpcErrorOutcome(-32602, `Unknown tool: ${name}`);
}

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  ctx: McpCtx,
): Promise<boolean> {
  const rawUrl = req.url ?? "/mcp";
  const pathname = rawUrl.split("?")[0];
  if (pathname !== "/mcp" && pathname !== "/mcp/") return false;
  const method = (req.method ?? "").toUpperCase();
  if (method !== "POST" && method !== "DELETE") return false;

  // Session teardown (mcp.md section 0.6): accept and ignore, never 500.
  if (method === "DELETE") {
    sendJson(res, 200, {});
    return true;
  }

  // 1. Parse the body as JSON. A syntactically invalid body is HTTP 400
  // with JSON-RPC -32700 (mcp.md section 3.10).
  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, "Parse error"));
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, "Parse error"));
    return true;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, rpcError(null, -32600, "Invalid Request"));
    return true;
  }

  // 2. Per-request auth, before any dispatch (mcp.md sections 3.15, 7).
  // No Authorization (or a wrong token) -> HTTP 401 exactly.
  if (!isAuthorized(req)) {
    sendJson(
      res,
      401,
      rpcError(
        parsed.id === undefined ? null : parsed.id,
        -32000,
        "Unauthorized",
      ),
    );
    return true;
  }

  const id: unknown = parsed.id === undefined ? null : parsed.id;
  const rpcMethod = typeof parsed.method === "string" ? parsed.method : "";

  // Notifications carry no id: acknowledge, no JSON-RPC response body.
  if (parsed.id === undefined) {
    res.writeHead(202, { "content-type": "application/json" });
    res.end("");
    return true;
  }

  const params: Record<string, unknown> = isRecord(parsed.params)
    ? parsed.params
    : {};
  const meta: Record<string, unknown> = isRecord(params._meta)
    ? (params._meta as Record<string, unknown>)
    : {};

  // Revision the client declares, from the header or _meta (both spellings).
  function declaredRevision(): string | undefined {
    const header = req.headers["mcp-protocol-version"];
    if (typeof header === "string" && isValidRevision(header)) return header;
    const fromMeta =
      meta["io.modelcontextprotocol/protocolVersion"] ?? meta.protocolVersion;
    if (isValidRevision(fromMeta)) return fromMeta;
    return undefined;
  }

  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

  if (rpcMethod === "server/discover") {
    const requested = declaredRevision();
    if (requested !== undefined && !SUPPORTED_VERSIONS.includes(requested)) {
      sendJson(
        res,
        200,
        rpcError(id, -32022, "Unsupported protocol version", {
          supported: SUPPORTED_VERSIONS,
        }),
      );
      return true;
    }
    const negotiated = requested ?? PREFERRED_VERSION;
    sendJson(
      res,
      200,
      rpcResult(id, {
        protocolVersion: negotiated,
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
      }),
    );
    return true;
  }

  if (rpcMethod === "initialize") {
    const offered = params.protocolVersion;
    if (!isValidRevision(offered)) {
      sendJson(
        res,
        200,
        rpcError(id, -32602, "Invalid protocol version"),
      );
      return true;
    }
    if (!SUPPORTED_VERSIONS.includes(offered)) {
      // -32602 is the only code that makes the legacy loop try the next
      // offered revision (mcp.md section 1.2).
      sendJson(
        res,
        200,
        rpcError(id, -32602, "Unsupported protocol version"),
      );
      return true;
    }
    sendJson(
      res,
      200,
      rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo,
      }),
    );
    return true;
  }

  if (rpcMethod === "tools/list") {
    // Reuse the pre-serialised tool table so two calls are byte-identical.
    const body =
      `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"tools":${TOOLS_JSON}}}`;
    sendRaw(res, 200, body);
    return true;
  }

  if (rpcMethod === "tools/call") {
    const toolName = typeof params.name === "string" ? params.name : "";
    const args: Record<string, unknown> = isRecord(params.arguments)
      ? params.arguments
      : {};
    if (toolName === "" || !TOOL_NAMES.has(toolName)) {
      // Unknown tool -> -32602 (or -32601), never HTTP 500 (mcp.md 3.9).
      sendJson(
        res,
        200,
        rpcError(id, -32602, `Unknown tool: ${toolName}`),
      );
      return true;
    }
    // A store throw (e.g. createPull on a missing branch ref, squashMerge
    // throwing per the store spec) must never become an HTTP 500: report it
    // as a tool-level error instead (mcp.md section 6: never HTTP 500).
    let outcome: DispatchOutcome;
    try {
      outcome = dispatchTool(store, ctx, toolName, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      sendJson(
        res,
        200,
        rpcResult(id, toolErrorResult(`Tool ${toolName} failed: ${message}`)),
      );
      return true;
    }
    if (outcome.kind === "rpcError") {
      sendJson(res, 200, rpcError(id, outcome.code, outcome.message));
      return true;
    }
    sendJson(res, 200, rpcResult(id, outcome.result));
    return true;
  }

  // Unknown method -> -32601 (also the pre-discover signal, mcp.md 1.2).
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${rpcMethod}`));
  return true;
}
