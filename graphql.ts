// graphql.ts — GraphQL v4 surface for make.fun github-core-clone-01.
// Hand-rolled parser/executor covering exactly the documents in
// gh-specs/graphql.md (the 20 conformance checks) plus __type/__schema
// introspection. No general GraphQL engine; no Date.now() per request
// (timestamps come from store.nextTimestamp()). Stdlib only, erasable TS.
// makefun anchor 2c6aebdc4330777a172c49a07dcd7d488aa016f1 round 34080036

type AnyObj = Record<string, any>;

const VIEWER_LOGIN = "adaiversen";

const ISSUE_FIELDS = ["id", "number", "title", "state", "body", "createdAt", "updatedAt", "closedAt", "author", "labels", "comments", "url"];
const PULL_REQUEST_FIELDS = ["id", "number", "title", "body", "state", "merged", "mergeable", "headRefName", "baseRefName", "files", "createdAt", "updatedAt", "author", "headRef", "baseRef", "mergedAt", "closedAt", "url"];
const REPOSITORY_FIELDS = ["id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "description", "private", "createdAt", "updatedAt", "defaultBranch"];
const USER_FIELDS = ["id", "login", "name", "email"];
const SEARCH_TYPE_VALUES = ["COMMIT", "DISCUSSION", "ISSUE", "REPOSITORY", "USER"];
const ISSUE_STATE_VALUES = ["OPEN", "CLOSED"];
const ISSUE_ORDER_FIELDS = ["CREATED_AT", "UPDATED_AT", "COMMENTS"];
const ORDER_DIRECTIONS = ["ASC", "DESC"];
const MERGEABLE_STATES = ["MERGEABLE", "CONFLICTING", "UNKNOWN"];
const PULL_REQUEST_STATES = ["OPEN", "CLOSED", "MERGED"];
const REPO_PERMISSIONS = ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"];
const MERGE_METHODS = ["MERGE", "SQUASH", "REBASE"];

const FIELD_DEFS: Record<string, string[]> = {
  Query: ["viewer", "repository", "node", "__type", "__schema"],
  Mutation: ["createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"],
  User: USER_FIELDS,
  Repository: REPOSITORY_FIELDS,
  Issue: ISSUE_FIELDS,
  IssueConnection: ["nodes", "pageInfo", "totalCount"],
  PageInfo: ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"],
  PullRequest: PULL_REQUEST_FIELDS,
  PullRequestConnection: ["nodes", "pageInfo", "totalCount"],
  PullRequestChangedFileConnection: ["nodes", "pageInfo", "totalCount"],
  PullRequestChangedFile: ["path"],
  Label: ["id", "name", "color", "description"],
  Ref: ["name", "target"],
  CreateIssuePayload: ["issue"],
  CloseIssuePayload: ["issue"],
  CreatePullRequestPayload: ["pullRequest"],
  MergePullRequestPayload: ["pullRequest"],
  AddCommentPayload: ["commentEdge"],
  CommentEdge: ["node", "cursor"],
  IssueComment: ["id", "body", "author", "user", "createdAt", "updatedAt"],
  __Type: ["name", "kind", "description", "fields", "enumValues", "possibleTypes", "interfaces", "inputFields"],
  __Field: ["name", "description", "type", "args"],
  __EnumValue: ["name", "description"],
  __InputValue: ["name", "description", "type"],
  __Schema: ["queryType", "mutationType", "types", "directives"],
  __Directive: ["name", "description", "locations", "args"],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlDecode(s: string): string | null {
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch (_e) {
    return null;
  }
}

function makeGlobalId(store: any, kind: string, repoId: number, num: number): string {
  try {
    if (store && typeof store.globalId === "function") return store.globalId(kind, repoId, num);
  } catch (_e) { /* fall through to local encoding */ }
  return b64urlEncode(kind + ":" + repoId + ":" + num);
}

function parseGlobalIdLocal(store: any, id: string): any {
  try {
    if (store && typeof store.parseGlobalId === "function") {
      const parsed = store.parseGlobalId(id);
      if (parsed) return parsed;
    }
  } catch (_e) { /* fall through */ }
  const decoded = b64urlDecode(String(id));
  if (!decoded) return null;
  const parts = decoded.split(":");
  if (parts.length !== 3) return null;
  const repoId = Number(parts[1]);
  const num = Number(parts[2]);
  if (!Number.isFinite(repoId) || !Number.isFinite(num)) return null;
  return { kind: parts[0], repoId: repoId, number: num };
}

function repoGlobalId(store: any, repo: any): string {
  // For a Repository the "number" slot carries the repo id itself, so the
  // parsed form round-trips repoId == number == repo.id.
  return makeGlobalId(store, "Repository", repo.id, repo.id);
}

function issueGlobalId(store: any, repo: any, issue: any): string {
  return makeGlobalId(store, "Issue", repo.id, issue.number);
}

function pullGlobalId(store: any, repo: any, pull: any): string {
  return makeGlobalId(store, "PullRequest", repo.id, pull.number);
}

function commentGlobalId(repo: any, issue: any, comment: any): string {
  return b64urlEncode("IssueComment:" + repo.id + ":" + issue.number + ":" + comment.id);
}

function encodeCursor(n: number): string {
  return b64urlEncode("cursor:" + n);
}

function decodeCursor(s: any): number | null {
  if (s === null || s === undefined || s === "") return null;
  const decoded = b64urlDecode(String(s));
  if (!decoded) return null;
  const m = /^cursor:(\d+)$/.exec(decoded);
  if (!m) return null;
  return Number(m[1]);
}

function findRepoById(store: any, repoId: number): any {
  if (!store || !store.repos) return undefined;
  for (const repo of store.repos.values()) {
    if (repo.id === repoId) return repo;
  }
  return undefined;
}

function viewerLogin(ctx: any): string {
  if (ctx && ctx.viewer && typeof ctx.viewer.login === "string" && ctx.viewer.login) return ctx.viewer.login;
  return VIEWER_LOGIN;
}

function viewerUser(ctx: any): any {
  if (ctx && ctx.viewer) return ctx.viewer;
  return { id: 1000, login: VIEWER_LOGIN, name: "ada iversen", email: "adaiversen@example.invalid" };
}

function isAuthed(req: any, ctx: any): boolean {
  if (ctx && typeof ctx.authed === "boolean") return ctx.authed;
  const header = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN || "";
  if (expected) return token === expected;
  return true;
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    req.on("data", (c: any) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (e: any) => reject(e));
  });
}

function sendJson(res: any, status: number, body: any): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token = { kind: string; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ",") { i++; continue; }
    if (ch === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (src.startsWith("...", i)) { tokens.push({ kind: "punct", value: "..." }); i += 3; continue; }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        const raw = end === -1 ? src.slice(i + 3) : src.slice(i + 3, end);
        tokens.push({ kind: "string", value: raw });
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === "n") out += "\n";
          else if (esc === "t") out += "\t";
          else if (esc === "r") out += "\r";
          else if (esc === "b") out += "\b";
          else if (esc === "f") out += "\f";
          else if (esc === "u") { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: "string", value: out });
      i = j + 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i;
      if (src[j] === "-") j++;
      while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
      let isFloat = false;
      if (src[j] === ".") { isFloat = true; j++; while (j < src.length && src[j] >= "0" && src[j] <= "9") j++; }
      if (src[j] === "e" || src[j] === "E") {
        isFloat = true; j++;
        if (src[j] === "+" || src[j] === "-") j++;
        while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
      }
      tokens.push({ kind: isFloat ? "float" : "int", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) j++;
      tokens.push({ kind: "name", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("{}()[]:!=$@&|".includes(ch)) { tokens.push({ kind: "punct", value: ch }); i++; continue; }
    throw new Error("Unexpected character in GraphQL document: " + ch);
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent; produces a small AST of plain objects)
// ---------------------------------------------------------------------------

function parseDocument(src: string): any {
  const tokens = tokenize(src);
  let pos = 0;
  function peek(): Token { return tokens[pos]; }
  function next(): Token { return tokens[pos++]; }
  function expectPunct(v: string): void {
    const t = next();
    if (t.kind !== "punct" || t.value !== v) throw new Error("Expected '" + v + "' but got '" + t.value + "'");
  }
  function expectName(v?: string): string {
    const t = next();
    if (t.kind !== "name") throw new Error("Expected name but got '" + t.value + "'");
    if (v !== undefined && t.value !== v) throw new Error("Expected '" + v + "' but got '" + t.value + "'");
    return t.value;
  }

  function parseValue(): any {
    const t = peek();
    if (t.kind === "punct" && t.value === "$") {
      next();
      return { kind: "variable", name: expectName() };
    }
    if (t.kind === "string") { next(); return { kind: "string", value: t.value }; }
    if (t.kind === "int") { next(); return { kind: "int", value: parseInt(t.value, 10) }; }
    if (t.kind === "float") { next(); return { kind: "float", value: parseFloat(t.value) }; }
    if (t.kind === "name") {
      next();
      if (t.value === "true") return { kind: "boolean", value: true };
      if (t.value === "false") return { kind: "boolean", value: false };
      if (t.value === "null") return { kind: "null", value: null };
      return { kind: "enum", value: t.value };
    }
    if (t.kind === "punct" && t.value === "[") {
      next();
      const values: any[] = [];
      while (!(peek().kind === "punct" && peek().value === "]")) values.push(parseValue());
      expectPunct("]");
      return { kind: "list", values: values };
    }
    if (t.kind === "punct" && t.value === "{") {
      next();
      const fields: AnyObj = {};
      while (!(peek().kind === "punct" && peek().value === "}")) {
        const name = expectName();
        expectPunct(":");
        fields[name] = parseValue();
      }
      expectPunct("}");
      return { kind: "object", fields: fields };
    }
    throw new Error("Unexpected value token: " + t.value);
  }

  function parseArguments(): AnyObj {
    const args: AnyObj = {};
    if (peek().kind === "punct" && peek().value === "(") {
      next();
      while (!(peek().kind === "punct" && peek().value === ")")) {
        const name = expectName();
        expectPunct(":");
        args[name] = parseValue();
      }
      expectPunct(")");
    }
    return args;
  }

  function parseDirectives(): any[] {
    const dirs: any[] = [];
    while (peek().kind === "punct" && peek().value === "@") {
      next();
      const name = expectName();
      const args = parseArguments();
      dirs.push({ name: name, args: args });
    }
    return dirs;
  }

  function parseSelectionSet(): any[] {
    expectPunct("{");
    const sels: any[] = [];
    while (!(peek().kind === "punct" && peek().value === "}")) sels.push(parseSelection());
    expectPunct("}");
    return sels;
  }

  function parseSelection(): any {
    if (peek().kind === "punct" && peek().value === "...") {
      next();
      if (peek().kind === "name" && peek().value === "on") {
        next();
        const typeCond = expectName();
        const directives = parseDirectives();
        return { kind: "inline", typeCondition: typeCond, directives: directives, selections: parseSelectionSet() };
      }
      if (peek().kind === "name") {
        const name = expectName();
        const directives = parseDirectives();
        return { kind: "spread", name: name, directives: directives };
      }
      const directives = parseDirectives();
      return { kind: "inline", typeCondition: null, directives: directives, selections: parseSelectionSet() };
    }
    const first = expectName();
    let alias: string | null = null;
    let name = first;
    if (peek().kind === "punct" && peek().value === ":") {
      next();
      alias = first;
      name = expectName();
    }
    const args = parseArguments();
    const directives = parseDirectives();
    let selections: any[] | null = null;
    if (peek().kind === "punct" && peek().value === "{") selections = parseSelectionSet();
    return { kind: "field", alias: alias, name: name, args: args, directives: directives, selections: selections };
  }

  function parseVarDefs(): any[] {
    const defs: any[] = [];
    if (peek().kind === "punct" && peek().value === "(") {
      next();
      while (!(peek().kind === "punct" && peek().value === ")")) {
        expectPunct("$");
        const name = expectName();
        expectPunct(":");
        // Type: sequence of names / [ ] / ! until '=', ',' or ')'.
        while (peek().kind === "name" || (peek().kind === "punct" && ["[", "]", "!"].includes(peek().value))) next();
        let def: any = null;
        if (peek().kind === "punct" && peek().value === "=") { next(); def = parseValue(); }
        defs.push({ name: name, defaultValue: def });
      }
      expectPunct(")");
    }
    return defs;
  }

  const operations: any[] = [];
  const fragments: AnyObj = {};
  while (peek().kind !== "eof") {
    const t = peek();
    if (t.kind === "punct" && t.value === "{") {
      operations.push({ kind: "query", name: null, varDefs: [], selections: parseSelectionSet() });
      continue;
    }
    if (t.kind === "name" && (t.value === "query" || t.value === "mutation" || t.value === "subscription")) {
      const opKind = next().value;
      let name: string | null = null;
      if (peek().kind === "name") name = expectName();
      const varDefs = parseVarDefs();
      parseDirectives();
      operations.push({ kind: opKind, name: name, varDefs: varDefs, selections: parseSelectionSet() });
      continue;
    }
    if (t.kind === "name" && t.value === "fragment") {
      next();
      const name = expectName();
      expectName("on");
      const typeCond = expectName();
      parseDirectives();
      fragments[name] = { typeCondition: typeCond, selections: parseSelectionSet() };
      continue;
    }
    throw new Error("Unexpected token in GraphQL document: " + t.value);
  }
  return { operations: operations, fragments: fragments };
}

function resolveValue(node: any, variables: AnyObj): any {
  if (!node) return undefined;
  switch (node.kind) {
    case "variable": return variables ? variables[node.name] : undefined;
    case "list": return node.values.map((v: any) => resolveValue(v, variables));
    case "object": {
      const out: AnyObj = {};
      for (const k of Object.keys(node.fields)) out[k] = resolveValue(node.fields[k], variables);
      return out;
    }
    default: return node.value;
  }
}

function resolveArgs(field: any, variables: AnyObj): AnyObj {
  const out: AnyObj = {};
  for (const k of Object.keys(field.args || {})) out[k] = resolveValue(field.args[k], variables);
  return out;
}

// ---------------------------------------------------------------------------
// Introspection data
// ---------------------------------------------------------------------------

function typeFieldsFor(name: string): string[] {
  switch (name) {
    case "Issue": return ISSUE_FIELDS;
    case "PullRequest": return PULL_REQUEST_FIELDS;
    case "Repository": return REPOSITORY_FIELDS;
    case "User": return USER_FIELDS;
    case "IssueConnection": return ["nodes", "pageInfo", "totalCount"];
    case "PullRequestConnection": return ["nodes", "pageInfo", "totalCount"];
    case "PullRequestChangedFileConnection": return ["nodes", "pageInfo", "totalCount"];
    case "PullRequestChangedFile": return ["path"];
    case "PageInfo": return ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"];
    case "Ref": return ["name", "target"];
    case "IssueComment": return ["id", "body", "author", "user", "createdAt", "updatedAt"];
    case "Query": return FIELD_DEFS.Query;
    case "Mutation": return FIELD_DEFS.Mutation;
    default: return [];
  }
}

function typeEnumValuesFor(name: string): string[] | null {
  switch (name) {
    case "SearchType": return SEARCH_TYPE_VALUES;
    case "IssueState": return ISSUE_STATE_VALUES;
    case "IssueOrderField": return ISSUE_ORDER_FIELDS;
    case "OrderDirection": return ORDER_DIRECTIONS;
    case "MergeableState": return MERGEABLE_STATES;
    case "PullRequestState": return PULL_REQUEST_STATES;
    case "RepositoryPermission": return REPO_PERMISSIONS;
    case "PullRequestMergeMethod": return MERGE_METHODS;
    default: return null;
  }
}

function knownTypeNames(): string[] {
  return ["Query", "Mutation", "Repository", "Issue", "PullRequest", "User", "IssueConnection", "PullRequestConnection", "PullRequestChangedFileConnection", "PullRequestChangedFile", "PageInfo", "Ref", "IssueComment", "IssueState", "IssueOrderField", "OrderDirection", "MergeableState", "PullRequestState", "RepositoryPermission", "PullRequestMergeMethod", "SearchType", "CreateIssueInput", "CloseIssueInput", "CreatePullRequestInput", "MergePullRequestInput", "AddCommentInput"];
}

function makeTypeWrapper(name: string): any {
  const enums = typeEnumValuesFor(name);
  return {
    __kind: "__Type",
    name: name,
    kind: enums ? "ENUM" : "OBJECT",
    fields: typeFieldsFor(name).map((f) => ({ __kind: "__Field", name: f })),
    enumValues: enums ? enums.map((v) => ({ __kind: "__EnumValue", name: v })) : null,
  };
}

// ---------------------------------------------------------------------------
// Git helpers for PullRequest.files
// ---------------------------------------------------------------------------

function treeMapAt(store: any, repo: any, treeOid: string, prefix: string, out: Map<string, string>): void {
  if (!treeOid || !store || typeof store.getObject !== "function" || typeof store.parseTree !== "function") return;
  const obj = store.getObject(repo, treeOid);
  if (!obj || !obj.data) return;
  let entries: any[];
  try { entries = store.parseTree(obj.data); } catch (_e) { return; }
  for (const entry of entries) {
    const path = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.mode === "40000" || entry.mode === "040000") {
      treeMapAt(store, repo, entry.oid, path, out);
    } else {
      out.set(path, entry.oid);
    }
  }
}

function commitTreeMap(store: any, repo: any, commitOid: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!commitOid || !store || typeof store.getObject !== "function" || typeof store.parseCommit !== "function") return out;
  const obj = store.getObject(repo, commitOid);
  if (!obj || !obj.data) return out;
  let info: any;
  try { info = store.parseCommit(obj.data); } catch (_e) { return out; }
  if (info && info.tree) treeMapAt(store, repo, info.tree, "", out);
  return out;
}

function changedFilePaths(store: any, repo: any, pull: any): string[] {
  try {
    const baseOid = (typeof store.getRef === "function" ? store.getRef(repo, "refs/heads/" + pull.baseRef) : undefined) || pull.baseSha || null;
    const headOid = (typeof store.getRef === "function" ? store.getRef(repo, "refs/heads/" + pull.headRef) : undefined) || pull.headSha || null;
    if (!baseOid || !headOid) return [];
    const baseMap = commitTreeMap(store, repo, baseOid);
    const headMap = commitTreeMap(store, repo, headOid);
    const paths = new Set<string>();
    for (const p of baseMap.keys()) if (baseMap.get(p) !== headMap.get(p)) paths.add(p);
    for (const p of headMap.keys()) if (baseMap.get(p) !== headMap.get(p)) paths.add(p);
    return Array.from(paths).sort();
  } catch (_e) {
    return [];
  }
}

function mergeableState(store: any, repo: any, pull: any): string {
  try {
    if (store && typeof store.isMergeConflict === "function") {
      return store.isMergeConflict(repo, pull) ? "CONFLICTING" : "MERGEABLE";
    }
  } catch (_e) { /* fall through */ }
  return "MERGEABLE";
}

function pullState(pull: any): string {
  if (pull.merged) return "MERGED";
  if (pull.state === "closed") return "CLOSED";
  return "OPEN";
}

function issueState(issue: any): string {
  return issue.state === "closed" ? "CLOSED" : "OPEN";
}

function doSquashMerge(store: any, repo: any, pull: any): string | null {
  if (store && typeof store.squashMerge === "function") {
    try {
      const oid = store.squashMerge(repo, pull);
      if (oid) return oid;
      if (pull.merged) return pull.mergeCommitSha || "merged";
    } catch (_e) { /* fall through to manual fallback */ }
  }
  // Manual fallback: one squash commit on the base branch whose tree is the
  // head tip's tree, parent is the base tip.
  try {
    const baseOid = store.getRef(repo, "refs/heads/" + pull.baseRef);
    const headOid = store.getRef(repo, "refs/heads/" + pull.headRef);
    if (!baseOid || !headOid) return null;
    const headObj = store.getObject(repo, headOid);
    if (!headObj) return null;
    const headInfo = store.parseCommit(headObj.data);
    const author = headInfo.committer || "adaiversen <adaiversen@example.invalid>";
    const commitData = store.buildCommit({
      tree: headInfo.tree, parents: [baseOid], author: author, committer: author,
      message: "Merge pull request #" + pull.number + " from " + pull.headRef,
    });
    const oid = store.putObject(repo, "commit", commitData);
    store.setRef(repo, "refs/heads/" + pull.baseRef, oid);
    pull.state = "closed";
    pull.merged = true;
    pull.mergeCommitSha = oid;
    const ts = typeof store.nextTimestamp === "function" ? store.nextTimestamp() : "2025-01-01T00:00:00.000Z";
    pull.mergedAt = ts;
    pull.closedAt = ts;
    pull.updatedAt = ts;
    return oid;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Issues listing: filter / sort / paginate (shared by issues and pageInfo)
// ---------------------------------------------------------------------------

function sortIssues(issues: any[], orderBy: any): any[] {
  const arr = issues.slice();
  if (!orderBy || !orderBy.field) return arr.sort((a, b) => a.number - b.number);
  const dir = orderBy.direction === "ASC" ? 1 : -1;
  const field = orderBy.field;
  arr.sort((a, b) => {
    let cmp = 0;
    if (field === "CREATED_AT") cmp = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    else if (field === "UPDATED_AT") cmp = String(a.updatedAt || "").localeCompare(String(b.updatedAt || ""));
    else if (field === "COMMENTS") cmp = (a.comments ? a.comments.length : 0) - (b.comments ? b.comments.length : 0);
    if (cmp !== 0) return cmp * dir;
    return (a.number - b.number) * dir;
  });
  return arr;
}

function listIssuesPage(store: any, repo: any, args: AnyObj): any {
  let issues: any[] = [];
  try {
    if (store && typeof store.listIssues === "function") issues = store.listIssues(repo, { state: "all" }) || [];
    else if (repo && repo.issues) issues = Array.from(repo.issues.values());
  } catch (_e) {
    if (repo && repo.issues) issues = Array.from(repo.issues.values());
  }
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states.map((s: any) => String(s).toUpperCase()));
    issues = issues.filter((iss) => wanted.has(issueState(iss)));
  }
  const sorted = sortIssues(issues, args.orderBy || null);
  let start = 0;
  if (args.after !== null && args.after !== undefined) {
    const afterNum = decodeCursor(args.after);
    if (afterNum !== null) {
      const idx = sorted.findIndex((iss) => iss.number === afterNum);
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = typeof args.first === "number" ? args.first : sorted.length - start;
  const page = sorted.slice(start, start + Math.max(0, first));
  const hasNextPage = start + page.length < sorted.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0].number) : null;
  return {
    __kind: "IssueConnection",
    repo: repo,
    issues: page,
    pageInfo: { __kind: "PageInfo", hasNextPage: hasNextPage, endCursor: endCursor, startCursor: startCursor, hasPreviousPage: start > 0 },
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

function fieldAllowed(parentKind: string, fieldName: string): boolean {
  const defs = FIELD_DEFS[parentKind];
  if (!defs) return false;
  return defs.includes(fieldName);
}

function directiveSkips(field: any, variables: AnyObj): boolean {
  for (const d of field.directives || []) {
    const args: AnyObj = {};
    for (const k of Object.keys(d.args || {})) args[k] = resolveValue(d.args[k], variables);
    if (d.name === "skip" && args.if === true) return true;
    if (d.name === "include" && args.if === false) return true;
  }
  return false;
}

function resolveField(exec: any, parentKind: string, parent: any, field: any, args: AnyObj): any {
  // Returns { value, childKind } where childKind is the __kind of a wrapper
  // value, or the element kind for arrays, or null for scalars.
  const store = exec.store;
  const ctx = exec.ctx;
  if (parentKind === "Query") {
    if (field.name === "viewer") return { value: { __kind: "User", user: viewerUser(ctx) }, childKind: "User" };
    if (field.name === "repository") {
      const repo = store && typeof store.getRepo === "function" ? store.getRepo(args.owner, args.name) : undefined;
      if (!repo) return { value: null, childKind: null };
      return { value: { __kind: "Repository", repo: repo }, childKind: "Repository" };
    }
    if (field.name === "node") {
      const parsed = parseGlobalIdLocal(store, args.id);
      if (!parsed) return { value: null, childKind: null };
      if (parsed.kind === "Repository") {
        const repo = findRepoById(store, parsed.repoId);
        if (!repo) return { value: null, childKind: null };
        return { value: { __kind: "Repository", repo: repo }, childKind: "Repository" };
      }
      if (parsed.kind === "Issue" || parsed.kind === "PullRequest") {
        const repo = findRepoById(store, parsed.repoId);
        if (!repo) return { value: null, childKind: null };
        if (parsed.kind === "Issue") {
          const issue = typeof store.getIssue === "function" ? store.getIssue(repo, parsed.number) : (repo.issues ? repo.issues.get(parsed.number) : undefined);
          if (!issue) return { value: null, childKind: null };
          return { value: { __kind: "Issue", repo: repo, issue: issue }, childKind: "Issue" };
        }
        const pull = typeof store.getPull === "function" ? store.getPull(repo, parsed.number) : (repo.pulls ? repo.pulls.get(parsed.number) : undefined);
        if (!pull) return { value: null, childKind: null };
        return { value: { __kind: "PullRequest", repo: repo, pull: pull }, childKind: "PullRequest" };
      }
      return { value: null, childKind: null };
    }
    if (field.name === "__type") {
      if (typeof args.name !== "string") return { value: null, childKind: null };
      if (!knownTypeNames().includes(args.name) && typeFieldsFor(args.name).length === 0 && !typeEnumValuesFor(args.name)) {
        return { value: null, childKind: null };
      }
      return { value: makeTypeWrapper(args.name), childKind: "__Type" };
    }
    if (field.name === "__schema") {
      return { value: { __kind: "__Schema" }, childKind: "__Schema" };
    }
  }
  if (parentKind === "Mutation") {
    if (field.name === "createIssue") {
      const input = args.input || {};
      const parsed = parseGlobalIdLocal(store, input.repositoryId);
      if (!parsed) throw new Error("createIssue: unknown repositoryId");
      const repo = findRepoById(store, parsed.repoId);
      if (!repo) throw new Error("createIssue: repository not found");
      const issue = store.createIssue(repo, { title: input.title, body: input.body || "" });
      return { value: { __kind: "CreateIssuePayload", repo: repo, issue: issue }, childKind: "CreateIssuePayload" };
    }
    if (field.name === "closeIssue") {
      const input = args.input || {};
      const parsed = parseGlobalIdLocal(store, input.issueId);
      if (!parsed) throw new Error("closeIssue: unknown issueId");
      const repo = findRepoById(store, parsed.repoId);
      if (!repo) throw new Error("closeIssue: repository not found");
      const issue = typeof store.getIssue === "function" ? store.getIssue(repo, parsed.number) : repo.issues.get(parsed.number);
      if (!issue) throw new Error("closeIssue: issue not found");
      issue.state = "closed";
      const ts = typeof store.nextTimestamp === "function" ? store.nextTimestamp() : "2025-01-01T00:00:00.000Z";
      issue.updatedAt = ts;
      issue.closedAt = ts;
      return { value: { __kind: "CloseIssuePayload", repo: repo, issue: issue }, childKind: "CloseIssuePayload" };
    }
    if (field.name === "createPullRequest") {
      const input = args.input || {};
      const parsed = parseGlobalIdLocal(store, input.repositoryId);
      if (!parsed) throw new Error("createPullRequest: unknown repositoryId");
      const repo = findRepoById(store, parsed.repoId);
      if (!repo) throw new Error("createPullRequest: repository not found");
      const pull = store.createPull(repo, { title: input.title, body: input.body || "", head: input.headRefName, base: input.baseRefName });
      return { value: { __kind: "CreatePullRequestPayload", repo: repo, pull: pull }, childKind: "CreatePullRequestPayload" };
    }
    if (field.name === "mergePullRequest") {
      const input = args.input || {};
      const parsed = parseGlobalIdLocal(store, input.pullRequestId);
      if (!parsed) throw new Error("mergePullRequest: unknown pullRequestId");
      const repo = findRepoById(store, parsed.repoId);
      if (!repo) throw new Error("mergePullRequest: repository not found");
      const pull = typeof store.getPull === "function" ? store.getPull(repo, parsed.number) : repo.pulls.get(parsed.number);
      if (!pull) throw new Error("mergePullRequest: pull request not found");
      if (!pull.merged) {
        const oid = doSquashMerge(store, repo, pull);
        if (!oid && !pull.merged) throw new Error("mergePullRequest: merge failed");
      }
      return { value: { __kind: "MergePullRequestPayload", repo: repo, pull: pull }, childKind: "MergePullRequestPayload" };
    }
    if (field.name === "addComment") {
      const input = args.input || {};
      const parsed = parseGlobalIdLocal(store, input.subjectId);
      if (!parsed) throw new Error("addComment: unknown subjectId");
      const repo = findRepoById(store, parsed.repoId);
      if (!repo) throw new Error("addComment: repository not found");
      const issue = typeof store.getIssue === "function" ? store.getIssue(repo, parsed.number) : repo.issues.get(parsed.number);
      if (!issue) throw new Error("addComment: issue not found");
      const comment = store.addIssueComment(repo, issue, input.body || "");
      return { value: { __kind: "AddCommentPayload", repo: repo, issue: issue, comment: comment }, childKind: "AddCommentPayload" };
    }
  }
  if (parentKind === "User") {
    const user = parent.user;
    if (field.name === "login") return { value: user.login, childKind: null };
    if (field.name === "id") return { value: String(user.id), childKind: null };
    if (field.name === "name") return { value: user.name || null, childKind: null };
    if (field.name === "email") return { value: user.email || null, childKind: null };
  }
  if (parentKind === "Repository") {
    const repo = parent.repo;
    if (field.name === "id") return { value: repoGlobalId(store, repo), childKind: null };
    if (field.name === "databaseId") return { value: repo.id, childKind: null };
    if (field.name === "name") return { value: repo.name, childKind: null };
    if (field.name === "nameWithOwner") return { value: repo.fullName, childKind: null };
    if (field.name === "owner") return { value: { __kind: "User", user: { id: 1000, login: repo.owner, name: repo.owner, email: repo.owner + "@example.invalid" } }, childKind: "User" };
    if (field.name === "defaultBranchRef") {
      const ref = typeof store.getRef === "function" ? store.getRef(repo, "refs/heads/" + repo.defaultBranch) : undefined;
      if (!ref) return { value: null, childKind: null };
      return { value: { __kind: "Ref", name: repo.defaultBranch }, childKind: "Ref" };
    }
    if (field.name === "viewerPermission") return { value: "ADMIN", childKind: null };
    if (field.name === "hasIssuesEnabled") return { value: true, childKind: null };
    if (field.name === "description") return { value: repo.description || "", childKind: null };
    if (field.name === "private") return { value: !!repo.private, childKind: null };
    if (field.name === "createdAt") return { value: repo.createdAt, childKind: null };
    if (field.name === "updatedAt") return { value: repo.updatedAt, childKind: null };
    if (field.name === "defaultBranch") return { value: repo.defaultBranch, childKind: null };
    if (field.name === "issue") {
      const issue = typeof store.getIssue === "function" ? store.getIssue(repo, args.number) : repo.issues.get(args.number);
      if (!issue) return { value: null, childKind: null };
      return { value: { __kind: "Issue", repo: repo, issue: issue }, childKind: "Issue" };
    }
    if (field.name === "issues") return { value: listIssuesPage(store, repo, args), childKind: "IssueConnection" };
    if (field.name === "pullRequests") {
      let pulls: any[] = [];
      try {
        pulls = typeof store.listPulls === "function" ? store.listPulls(repo, { state: "all" }) || [] : Array.from(repo.pulls.values());
      } catch (_e) { pulls = Array.from(repo.pulls.values()); }
      pulls = pulls.slice().sort((a, b) => a.number - b.number);
      if (typeof args.first === "number") pulls = pulls.slice(0, args.first);
      return { value: { __kind: "PullRequestConnection", repo: repo, pulls: pulls }, childKind: "PullRequestConnection" };
    }
    if (field.name === "pullRequest") {
      const pull = typeof store.getPull === "function" ? store.getPull(repo, args.number) : repo.pulls.get(args.number);
      if (!pull) return { value: null, childKind: null };
      return { value: { __kind: "PullRequest", repo: repo, pull: pull }, childKind: "PullRequest" };
    }
  }
  if (parentKind === "Issue") {
    const issue = parent.issue;
    const repo = parent.repo;
    if (field.name === "id") return { value: issueGlobalId(store, repo, issue), childKind: null };
    if (field.name === "number") return { value: issue.number, childKind: null };
    if (field.name === "title") return { value: issue.title, childKind: null };
    if (field.name === "state") return { value: issueState(issue), childKind: null };
    if (field.name === "body") return { value: issue.body, childKind: null };
    if (field.name === "createdAt") return { value: issue.createdAt, childKind: null };
    if (field.name === "updatedAt") return { value: issue.updatedAt, childKind: null };
    if (field.name === "closedAt") return { value: issue.closedAt || null, childKind: null };
    if (field.name === "author") return { value: { __kind: "User", user: issue.user || viewerUser(ctx) }, childKind: "User" };
    if (field.name === "labels") return { value: (issue.labels || []).map((l: any) => (typeof l === "string" ? { __kind: "Label", name: l, color: null, description: null } : { __kind: "Label", name: l.name, color: l.color || null, description: l.description || null, id: l.id })), childKind: "Label" };
    if (field.name === "comments") return { value: (issue.comments || []).map((c: any) => ({ __kind: "IssueComment", repo: repo, issue: issue, comment: c })), childKind: "IssueComment" };
    if (field.name === "url") return { value: null, childKind: null };
  }
  if (parentKind === "IssueConnection") {
    if (field.name === "nodes") {
      return { value: parent.issues.map((iss: any) => ({ __kind: "Issue", repo: parent.repo, issue: iss })), childKind: "Issue" };
    }
    if (field.name === "pageInfo") return { value: parent.pageInfo, childKind: "PageInfo" };
    if (field.name === "totalCount") return { value: parent.issues.length, childKind: null };
  }
  if (parentKind === "PageInfo") {
    if (field.name === "hasNextPage") return { value: !!parent.hasNextPage, childKind: null };
    if (field.name === "hasPreviousPage") return { value: !!parent.hasPreviousPage, childKind: null };
    if (field.name === "endCursor") return { value: parent.endCursor || null, childKind: null };
    if (field.name === "startCursor") return { value: parent.startCursor || null, childKind: null };
  }
  if (parentKind === "PullRequest") {
    const pull = parent.pull;
    const repo = parent.repo;
    if (field.name === "id") return { value: pullGlobalId(store, repo, pull), childKind: null };
    if (field.name === "number") return { value: pull.number, childKind: null };
    if (field.name === "title") return { value: pull.title, childKind: null };
    if (field.name === "body") return { value: pull.body, childKind: null };
    if (field.name === "state") return { value: pullState(pull), childKind: null };
    if (field.name === "merged") return { value: !!pull.merged, childKind: null };
    if (field.name === "mergeable") return { value: mergeableState(store, repo, pull), childKind: null };
    if (field.name === "headRefName") return { value: pull.headRef, childKind: null };
    if (field.name === "baseRefName") return { value: pull.baseRef, childKind: null };
    if (field.name === "headRef") return { value: { __kind: "Ref", name: pull.headRef }, childKind: "Ref" };
    if (field.name === "baseRef") return { value: { __kind: "Ref", name: pull.baseRef }, childKind: "Ref" };
    if (field.name === "createdAt") return { value: pull.createdAt, childKind: null };
    if (field.name === "updatedAt") return { value: pull.updatedAt, childKind: null };
    if (field.name === "mergedAt") return { value: pull.mergedAt || null, childKind: null };
    if (field.name === "closedAt") return { value: pull.closedAt || null, childKind: null };
    if (field.name === "author") return { value: { __kind: "User", user: pull.user || viewerUser(ctx) }, childKind: "User" };
    if (field.name === "url") return { value: null, childKind: null };
    if (field.name === "files") {
      let paths = changedFilePaths(store, repo, pull);
      if (typeof args.first === "number") paths = paths.slice(0, args.first);
      return {
        value: {
          __kind: "PullRequestChangedFileConnection",
          files: paths.map((p) => ({ __kind: "PullRequestChangedFile", path: p })),
        },
        childKind: "PullRequestChangedFileConnection",
      };
    }
  }
  if (parentKind === "PullRequestConnection") {
    if (field.name === "nodes") {
      return { value: parent.pulls.map((p: any) => ({ __kind: "PullRequest", repo: parent.repo, pull: p })), childKind: "PullRequest" };
    }
    if (field.name === "pageInfo") return { value: { __kind: "PageInfo", hasNextPage: false, endCursor: null, startCursor: null, hasPreviousPage: false }, childKind: "PageInfo" };
    if (field.name === "totalCount") return { value: parent.pulls.length, childKind: null };
  }
  if (parentKind === "PullRequestChangedFileConnection") {
    if (field.name === "nodes") return { value: parent.files, childKind: "PullRequestChangedFile" };
    if (field.name === "pageInfo") return { value: { __kind: "PageInfo", hasNextPage: false, endCursor: null, startCursor: null, hasPreviousPage: false }, childKind: "PageInfo" };
    if (field.name === "totalCount") return { value: parent.files.length, childKind: null };
  }
  if (parentKind === "PullRequestChangedFile") {
    if (field.name === "path") return { value: parent.path, childKind: null };
  }
  if (parentKind === "Ref") {
    if (field.name === "name") return { value: parent.name, childKind: null };
    if (field.name === "target") return { value: null, childKind: null };
  }
  if (parentKind === "CreateIssuePayload" || parentKind === "CloseIssuePayload") {
    if (field.name === "issue") return { value: { __kind: "Issue", repo: parent.repo, issue: parent.issue }, childKind: "Issue" };
  }
  if (parentKind === "CreatePullRequestPayload" || parentKind === "MergePullRequestPayload") {
    if (field.name === "pullRequest") return { value: { __kind: "PullRequest", repo: parent.repo, pull: parent.pull }, childKind: "PullRequest" };
  }
  if (parentKind === "AddCommentPayload") {
    if (field.name === "commentEdge") return { value: { __kind: "CommentEdge", repo: parent.repo, issue: parent.issue, comment: parent.comment }, childKind: "CommentEdge" };
  }
  if (parentKind === "CommentEdge") {
    if (field.name === "node") return { value: { __kind: "IssueComment", repo: parent.repo, issue: parent.issue, comment: parent.comment }, childKind: "IssueComment" };
    if (field.name === "cursor") return { value: encodeCursor(parent.comment.id || 0), childKind: null };
  }
  if (parentKind === "IssueComment") {
    const comment = parent.comment;
    if (field.name === "id") return { value: commentGlobalId(parent.repo, parent.issue, comment), childKind: null };
    if (field.name === "body") return { value: comment.body, childKind: null };
    if (field.name === "author" || field.name === "user") return { value: { __kind: "User", user: comment.user || viewerUser(ctx) }, childKind: "User" };
    if (field.name === "createdAt") return { value: comment.createdAt, childKind: null };
    if (field.name === "updatedAt") return { value: comment.updatedAt, childKind: null };
  }
  if (parentKind === "__Type") {
    if (field.name === "name") return { value: parent.name, childKind: null };
    if (field.name === "kind") return { value: parent.kind, childKind: null };
    if (field.name === "description") return { value: null, childKind: null };
    if (field.name === "fields") return { value: parent.fields || [], childKind: "__Field" };
    if (field.name === "enumValues") return { value: parent.enumValues || [], childKind: "__EnumValue" };
    if (field.name === "possibleTypes") return { value: [], childKind: "__Type" };
    if (field.name === "interfaces") return { value: [], childKind: "__Type" };
    if (field.name === "inputFields") return { value: [], childKind: "__InputValue" };
  }
  if (parentKind === "__Field") {
    if (field.name === "name") return { value: parent.name, childKind: null };
    if (field.name === "description") return { value: null, childKind: null };
    if (field.name === "type") return { value: null, childKind: null };
    if (field.name === "args") return { value: [], childKind: "__InputValue" };
  }
  if (parentKind === "__EnumValue") {
    if (field.name === "name") return { value: parent.name, childKind: null };
    if (field.name === "description") return { value: null, childKind: null };
  }
  if (parentKind === "__InputValue") {
    if (field.name === "name") return { value: parent.name, childKind: null };
    if (field.name === "description") return { value: null, childKind: null };
    if (field.name === "type") return { value: null, childKind: null };
  }
  if (parentKind === "__Schema") {
    if (field.name === "queryType") return { value: makeTypeWrapper("Query"), childKind: "__Type" };
    if (field.name === "mutationType") return { value: makeTypeWrapper("Mutation"), childKind: "__Type" };
    if (field.name === "types") return { value: knownTypeNames().map((n) => makeTypeWrapper(n)), childKind: "__Type" };
    if (field.name === "directives") return { value: [], childKind: "__Directive" };
  }
  if (parentKind === "Label") {
    if (field.name === "name") return { value: parent.name, childKind: null };
    if (field.name === "id") return { value: parent.id !== undefined && parent.id !== null ? String(parent.id) : null, childKind: null };
    if (field.name === "color") return { value: parent.color || null, childKind: null };
    if (field.name === "description") return { value: parent.description || null, childKind: null };
  }
  throw new Error('Cannot query field "' + field.name + '" on type "' + parentKind + '".');
}

function executeSelectionSet(exec: any, selections: any[], parentKind: string, parent: any, out: AnyObj, path: (string | number)[]): void {
  for (const sel of selections) {
    if (sel.kind === "spread") {
      const frag = exec.fragments[sel.name];
      if (!frag) {
        exec.errors.push({ message: 'Unknown fragment "' + sel.name + '".', path: path.slice() });
        continue;
      }
      if (frag.typeCondition && frag.typeCondition !== parentKind) continue;
      executeSelectionSet(exec, frag.selections, parentKind, parent, out, path);
      continue;
    }
    if (sel.kind === "inline") {
      if (sel.typeCondition && sel.typeCondition !== parentKind) continue;
      executeSelectionSet(exec, sel.selections, parentKind, parent, out, path);
      continue;
    }
    // field
    if (directiveSkips(sel, exec.variables)) continue;
    const key = sel.alias || sel.name;
    const fieldPath = path.concat([key]);
    if (!fieldAllowed(parentKind, sel.name)) {
      exec.errors.push({
        message: 'Cannot query field "' + sel.name + '" on type "' + parentKind + '".',
        path: fieldPath,
        locations: [{ line: 1, column: 1 }],
      });
      continue;
    }
    let resolved: any;
    try {
      const args = resolveArgs(sel, exec.variables);
      resolved = resolveField(exec, parentKind, parent, sel, args);
    } catch (e: any) {
      exec.errors.push({ message: e && e.message ? String(e.message) : "Field error", path: fieldPath });
      out[key] = null;
      continue;
    }
    const value = resolved.value;
    const childKind = resolved.childKind;
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (!sel.selections || sel.selections.length === 0) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item: any, idx: number) => {
        if (item === null || item === undefined) return null;
        if (typeof item === "object" && item.__kind) {
          const nested: AnyObj = {};
          executeSelectionSet(exec, sel.selections, item.__kind, item, nested, fieldPath.concat([idx]));
          return nested;
        }
        return item;
      });
      continue;
    }
    if (typeof value === "object" && value.__kind) {
      const nested: AnyObj = {};
      executeSelectionSet(exec, sel.selections, value.__kind, value, nested, fieldPath);
      out[key] = nested;
      continue;
    }
    // Scalar with a (bogus) sub-selection: return the scalar.
    out[key] = value;
  }
}

function executeOperation(store: any, ctx: any, doc: any, body: any): any {
  const variables: AnyObj = (body && body.variables && typeof body.variables === "object") ? body.variables : {};
  const query = body && typeof body.query === "string" ? body.query : "";
  if (!query) return { data: null, errors: [{ message: "GraphQL query is required." }] };
  let parsed: any;
  try {
    parsed = parseDocument(query);
  } catch (e: any) {
    return { data: null, errors: [{ message: e && e.message ? String(e.message) : "GraphQL syntax error." }] };
  }
  if (!parsed.operations || parsed.operations.length === 0) {
    return { data: null, errors: [{ message: "No operation in GraphQL document." }] };
  }
  let op = parsed.operations[0];
  if (body && typeof body.operationName === "string" && body.operationName) {
    const found = parsed.operations.find((o: any) => o.name === body.operationName);
    if (found) op = found;
  }
  const rootKind = op.kind === "mutation" ? "Mutation" : "Query";
  const exec: any = { store: store, ctx: ctx, variables: variables, errors: [], fragments: parsed.fragments || {} };
  const data: AnyObj = {};
  try {
    executeSelectionSet(exec, op.selections, rootKind, {}, data, []);
  } catch (e: any) {
    exec.errors.push({ message: e && e.message ? String(e.message) : "Execution error." });
  }
  const envelope: AnyObj = { data: data };
  if (exec.errors.length > 0) envelope.errors = exec.errors;
  return envelope;
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleGraphql(req: any, res: any, store: any, ctx: any): Promise<boolean> {
  let pathname = "";
  try {
    pathname = new URL(req.url || "/", "http://localhost").pathname;
  } catch (_e) {
    pathname = String(req.url || "").split("?")[0];
  }
  if (pathname !== "/api/graphql") return false;
  if (req.method !== "POST") return false;
  if (!isAuthed(req, ctx)) {
    sendJson(res, 401, { message: "Bad credentials" });
    return true;
  }
  let raw = "";
  try {
    raw = await readBody(req);
  } catch (_e) {
    sendJson(res, 400, { errors: [{ message: "Could not read request body." }] });
    return true;
  }
  let body: any;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch (_e) {
    sendJson(res, 400, { errors: [{ message: "Request body is not valid JSON." }] });
    return true;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry: any) => executeOperation(store, ctx, null, entry));
    sendJson(res, 200, results);
    return true;
  }
  const envelope = executeOperation(store, ctx, null, body || {});
  sendJson(res, 200, envelope);
  return true;
}
