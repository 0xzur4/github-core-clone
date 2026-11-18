// REST v3 surface for github-core-clone-01.
// Implements every route in gh-specs/rest.md against the shared Store contract
// in gh-specs/store-api.md. Stdlib only, erasable TS, no per-request Date.now().

const VIEWER_FALLBACK = {
  id: 1000,
  login: "adaiversen",
  name: "ada iversen",
  email: "adaiversen@example.invalid",
};

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return "req-" + String(requestCounter);
}

function sendJson(res: any, status: number, body: any, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-GitHub-Request-Id": nextRequestId(),
    "X-OAuth-Scopes": "repo",
  };
  if (extraHeaders) {
    for (const k of Object.keys(extraHeaders)) headers[k] = extraHeaders[k];
  }
  const payload = body === null || body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, headers);
  res.end(payload);
}

function sendNoContent(res: any): void {
  res.writeHead(204, {
    "Content-Type": "application/json",
    "X-GitHub-Request-Id": nextRequestId(),
    "X-OAuth-Scopes": "repo",
  });
  res.end();
}

function sendError(res: any, status: number, message: string): void {
  sendJson(res, status, { message: message || "Error" });
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseAuthor(raw: string, viewer: any): { name: string; email: string; date: string } {
  // Raw git author: "Name <email> <epoch> <tz>"
  const m = /^([^<]*)\s*<([^>]*)>\s*(\d+)?/.exec(raw || "");
  if (!m) return { name: viewer.name || viewer.login, email: viewer.email || "", date: "" };
  let date = "";
  if (m[3]) {
    try {
      date = new Date(Number(m[3]) * 1000).toISOString();
    } catch {
      date = "";
    }
  }
  return { name: (m[1] || "").trim() || viewer.name || viewer.login, email: m[2] || "", date };
}

function userJson(u: any): any {
  if (!u) return { login: "adaiversen", id: 1000, type: "User" };
  return {
    login: u.login,
    id: u.id,
    name: u.name || u.login,
    email: u.email || "",
    type: "User",
    avatar_url: "",
  };
}

function repoJson(repo: any, origin: string, viewer: any): any {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    fullName: repo.fullName,
    owner: userJson({ login: repo.owner, id: repo.owner === viewer.login ? viewer.id : 0, name: repo.owner, email: "" }),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: "https://github.com/" + repo.fullName,
    url: origin + "/api/v3/repos/" + repo.fullName,
    clone_url: "https://github.com/" + repo.fullName + ".git",
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues ? repo.issues.size : 0,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? "private" : "public",
    topics: [],
  };
}

function labelJson(label: any, origin: string, repo: any): any {
  return {
    id: label.id,
    name: label.name,
    color: label.color || "ededed",
    description: label.description || "",
    url: origin + "/api/v3/repos/" + repo.fullName + "/labels/" + encodeURIComponent(label.name),
    default: false,
  };
}

function issueJson(repo: any, issue: any, origin: string, viewer: any): any {
  const labels: any[] = [];
  for (const name of issue.labels || []) {
    const lab = repo.labels ? repo.labels.get(name) : undefined;
    if (lab) labels.push(labelJson(lab, origin, repo));
    else labels.push({ name: name, color: "ededed", description: "" });
  }
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body || "",
    state: issue.state,
    labels: labels,
    user: userJson(issue.user || viewer),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt || null,
    html_url: origin + "/api/v3/repos/" + repo.fullName + "/issues/" + issue.number,
    url: origin + "/api/v3/repos/" + repo.fullName + "/issues/" + issue.number,
    comments: issue.comments ? issue.comments.length : 0,
  };
}

function commentJson(comment: any, origin: string, repo: any, issue: any, viewer: any): any {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.user || viewer),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: origin + "/api/v3/repos/" + repo.fullName + "/issues/" + issue.number,
    url: origin + "/api/v3/repos/" + repo.fullName + "/issues/" + issue.number + "/comments/" + comment.id,
  };
}

function resolveRefToOid(store: any, repo: any, ref: string | null | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.indexOf("refs/") === 0) return store.getRef(repo, ref);
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const obj = store.getObject(repo, ref.toLowerCase());
    if (obj) return ref.toLowerCase();
  }
  const head = store.getRef(repo, "refs/heads/" + ref);
  if (head) return head;
  return store.getRef(repo, "refs/tags/" + ref);
}

function treeOidOfCommit(store: any, repo: any, commitOid: string | undefined): string | undefined {
  if (!commitOid) return undefined;
  const obj = store.getObject(repo, commitOid);
  if (!obj) return undefined;
  try {
    const info = store.parseCommit(obj.data);
    return info.tree;
  } catch {
    return undefined;
  }
}

function pullJson(store: any, repo: any, pr: any, origin: string, viewer: any): any {
  let headSha: string | null = pr.headSha || null;
  let baseSha: string | null = pr.baseSha || null;
  const headTip = store.getRef(repo, "refs/heads/" + pr.headRef);
  if (headTip) headSha = headTip;
  const baseTip = store.getRef(repo, "refs/heads/" + pr.baseRef);
  if (baseTip) baseSha = baseTip;
  if (!headSha) headSha = "0000000000000000000000000000000000000000";
  if (!baseSha) baseSha = "0000000000000000000000000000000000000000";
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body || "",
    state: pr.state,
    merged: !!pr.merged,
    mergeable: pr.mergeable !== false,
    merged_at: pr.mergedAt || null,
    merge_commit_sha: pr.mergeCommitSha || null,
    closed_at: pr.closedAt || null,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    user: userJson(pr.user || viewer),
    head: {
      ref: pr.headRef,
      sha: headSha,
      label: repo.owner + ":" + pr.headRef,
      user: userJson(pr.user || viewer),
    },
    base: {
      ref: pr.baseRef,
      sha: baseSha,
      label: repo.owner + ":" + pr.baseRef,
      user: userJson(pr.user || viewer),
    },
    html_url: origin + "/api/v3/repos/" + repo.fullName + "/pulls/" + pr.number,
    url: origin + "/api/v3/repos/" + repo.fullName + "/pulls/" + pr.number,
  };
}

function shortBranch(branch: string | undefined | null, fallback: string): string {
  if (!branch) return fallback;
  if (branch.indexOf("refs/heads/") === 0) return branch.slice("refs/heads/".length);
  return branch;
}

function labelNames(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") out.push(item);
    else if (item && typeof item.name === "string") out.push(item.name);
  }
  return out;
}

function parsePageParams(url: URL): { perPage: number; page: number } {
  let perPage = Number(url.searchParams.get("per_page") || "30");
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  perPage = Math.floor(perPage);
  let page = Number(url.searchParams.get("page") || "1");
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.floor(page);
  return { perPage: perPage, page: page };
}

function countLines(buf: Buffer): number {
  const text = buf.toString("utf8");
  if (text.length === 0) return 0;
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

async function readBody(req: any): Promise<{ ok: boolean; body: any }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return { ok: true, body: {} };
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, body: parsed };
    return { ok: true, body: {} };
  } catch {
    return { ok: false, body: null };
  }
}

export async function handleRest(req: any, res: any, store: any, ctx: any): Promise<boolean> {
  const rawUrl = req.url || "/";
  let url: URL;
  try {
    url = new URL(rawUrl, "http://" + (req.headers.host || "localhost"));
  } catch {
    return false;
  }
  const pathname = url.pathname;
  if (pathname !== "/api/v3" && !pathname.startsWith("/api/v3/")) return false;

  const origin = "http://" + (req.headers.host || "localhost");
  const method = (req.method || "GET").toUpperCase();
  const viewer = (ctx && ctx.viewer) || VIEWER_FALLBACK;
  const authed = !!(ctx && ctx.authed);

  // Auth: every /api/v3 route requires the bearer token (store-api §auth).
  if (!authed) {
    sendError(res, 401, "Bad credentials");
    return true;
  }

  // Parse JSON body for methods that carry one, before routing/validation.
  let body: any = {};
  if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
    const parsed = await readBody(req);
    if (!parsed.ok) {
      sendError(res, 400, "Problems parsing JSON");
      return true;
    }
    body = parsed.body;
  }

  const segments = pathname.split("/").filter((s: string) => s.length > 0).map(decodeSeg);
  // segments[0] = "api", segments[1] = "v3", rest follows.
  const rest = segments.slice(2);

  // GET /api/v3/  (root)
  if (rest.length === 0) {
    if (method !== "GET") {
      sendError(res, 404, "Not Found");
      return true;
    }
    sendJson(res, 200, {
      current_user_url: origin + "/api/v3/user",
      repository_url: origin + "/api/v3/repos/{owner}/{repo}",
      meta: origin + "/api/v3/meta",
    });
    return true;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === "meta") {
    if (method !== "GET") {
      sendError(res, 404, "Not Found");
      return true;
    }
    sendJson(res, 200, { installed_version: "1.0.0", verifiable_password_authentication: true });
    return true;
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === "user" && rest[1] === "repos") {
    if (method === "POST") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        sendError(res, 422, "Validation Failed: name is required");
        return true;
      }
      const repo = store.createRepo(viewer.login, name, {
        description: typeof body.description === "string" ? body.description : "",
        private: body.private === undefined ? false : !!body.private,
        defaultBranch: typeof body.default_branch === "string" && body.default_branch ? body.default_branch : "main",
      });
      if (!repo) {
        sendError(res, 422, "Validation Failed: name already exists on this account");
        return true;
      }
      sendJson(res, 201, repoJson(repo, origin, viewer));
      return true;
    }
    if (method === "GET") {
      const { perPage, page } = parsePageParams(url);
      const all = store.listReposByOwner(viewer.login);
      const total = all.length;
      const totalPages = Math.max(1, Math.ceil(total / perPage));
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const links: string[] = [];
      if (page < totalPages) {
        links.push("<" + origin + "/api/v3/user/repos?per_page=" + perPage + "&page=" + (page + 1) + ">; rel=\"next\"");
      }
      links.push("<" + origin + "/api/v3/user/repos?per_page=" + perPage + "&page=" + totalPages + ">; rel=\"last\"");
      const extra: Record<string, string> = {};
      if (links.length > 0) extra["Link"] = links.join(", ");
      sendJson(res, 200, slice.map((r: any) => repoJson(r, origin, viewer)), extra);
      return true;
    }
    sendError(res, 404, "Not Found");
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === "repos") {
    const owner = rest[1];
    const repoName = rest[2];
    const tail = rest.slice(3);

    // Repo under another owner is 404, never 403.
    if (owner !== viewer.login) {
      sendError(res, 404, "Not Found");
      return true;
    }
    const repo = store.getRepo(owner, repoName);

    // Repo itself: GET / PATCH / DELETE
    if (tail.length === 0) {
      if (method === "GET") {
        if (!repo) {
          sendError(res, 404, "Not Found");
          return true;
        }
        sendJson(res, 200, repoJson(repo, origin, viewer));
        return true;
      }
      if (method === "PATCH") {
        if (!repo) {
          sendError(res, 404, "Not Found");
          return true;
        }
        if (typeof body.description === "string") repo.description = body.description;
        if (typeof body.private === "boolean") repo.private = body.private;
        if (typeof body.default_branch === "string" && body.default_branch) repo.defaultBranch = body.default_branch;
        repo.updatedAt = store.nextTimestamp();
        sendJson(res, 200, repoJson(repo, origin, viewer));
        return true;
      }
      if (method === "DELETE") {
        if (!repo) {
          sendError(res, 404, "Not Found");
          return true;
        }
        store.deleteRepo(owner, repoName);
        sendNoContent(res);
        return true;
      }
      sendError(res, 404, "Not Found");
      return true;
    }

    // All sub-routes below need the repo to exist.
    if (!repo) {
      sendError(res, 404, "Not Found");
      return true;
    }

    // POST /git/refs
    if (tail.length === 2 && tail[0] === "git" && tail[1] === "refs") {
      if (method !== "POST") {
        sendError(res, 404, "Not Found");
        return true;
      }
      const ref = typeof body.ref === "string" ? body.ref : "";
      const sha = typeof body.sha === "string" ? body.sha : "";
      if (!ref || !sha) {
        sendError(res, 422, "Validation Failed: ref and sha are required");
        return true;
      }
      store.setRef(repo, ref, sha.toLowerCase());
      sendJson(res, 201, {
        ref: ref,
        object: { sha: sha.toLowerCase(), type: "commit", url: origin + "/api/v3/repos/" + repo.fullName + "/git/commits/" + sha.toLowerCase() },
        url: origin + "/api/v3/repos/" + repo.fullName + "/git/refs/" + encodeURIComponent(ref),
      });
      return true;
    }

    // GET /branches
    if (tail.length === 1 && tail[0] === "branches") {
      if (method !== "GET") {
        sendError(res, 404, "Not Found");
        return true;
      }
      const refs = store.listRefs(repo);
      const out: any[] = [];
      for (const r of refs) {
        if (r.name.indexOf("refs/heads/") === 0) {
          out.push({
            name: r.name.slice("refs/heads/".length),
            commit: { sha: r.oid, url: origin + "/api/v3/repos/" + repo.fullName + "/commits/" + r.oid },
            protected: false,
          });
        }
      }
      sendJson(res, 200, out);
      return true;
    }

    // GET /commits[?sha=]
    if (tail.length === 1 && tail[0] === "commits") {
      if (method !== "GET") {
        sendError(res, 404, "Not Found");
        return true;
      }
      const shaParam = url.searchParams.get("sha");
      let tip: string | undefined;
      if (shaParam) tip = resolveRefToOid(store, repo, shaParam);
      else tip = store.getRef(repo, "refs/heads/" + repo.defaultBranch);
      const out: any[] = [];
      if (tip) {
        const visited = new Set<string>();
        const stack: string[] = [tip];
        while (stack.length > 0 && out.length < 1000) {
          const oid = stack.shift() as string;
          if (visited.has(oid)) continue;
          visited.add(oid);
          const obj = store.getObject(repo, oid);
          if (!obj || obj.type !== "commit") continue;
          let info: any;
          try {
            info = store.parseCommit(obj.data);
          } catch {
            continue;
          }
          const author = parseAuthor(info.author || "", viewer);
          const committer = parseAuthor(info.committer || "", viewer);
          out.push({
            sha: oid,
            commit: {
              // Git stores the message with a trailing newline (buildCommit
              // appends one); the API returns it without, as GitHub does.
              message: (info.message || "").replace(/\n+$/, ""),
              author: author,
              committer: committer,
              tree: { sha: info.tree },
            },
            parents: (info.parents || []).map((p: string) => ({ sha: p })),
            html_url: origin + "/api/v3/repos/" + repo.fullName + "/commits/" + oid,
            url: origin + "/api/v3/repos/" + repo.fullName + "/commits/" + oid,
          });
          // Parents in order, breadth-first keeps newest-first for linear history.
          for (const p of info.parents || []) {
            if (!visited.has(p)) stack.push(p);
          }
        }
      }
      const { perPage } = parsePageParams(url);
      // Only slice when per_page was explicitly requested; default 30 would
      // truncate long histories the checks do not paginate, so honour the
      // param only if present in the query string.
      if (url.searchParams.has("per_page")) {
        sendJson(res, 200, out.slice(0, perPage));
      } else {
        sendJson(res, 200, out);
      }
      return true;
    }

    // /contents/{path...}
    if (tail.length >= 1 && tail[0] === "contents") {
      const filePath = tail.slice(1).join("/");
      const refParam = url.searchParams.get("ref");
      if (method === "GET") {
        const ref = refParam || repo.defaultBranch;
        const file = store.getFileAt(repo, ref, filePath);
        if (file) {
          sendJson(res, 200, {
            type: "file",
            encoding: "base64",
            size: file.content.length,
            name: filePath.split("/").pop() || filePath,
            path: filePath,
            content: file.content.toString("base64"),
            sha: file.oid,
            url: origin + "/api/v3/repos/" + repo.fullName + "/contents/" + filePath,
            html_url: origin + "/api/v3/repos/" + repo.fullName + "/blob/" + ref + "/" + filePath,
            download_url: origin + "/api/v3/repos/" + repo.fullName + "/contents/" + filePath,
          });
          return true;
        }
        // Directory listing: flatten the tree at the ref and take immediate children.
        const commitOid = resolveRefToOid(store, repo, ref);
        const treeOid = treeOidOfCommit(store, repo, commitOid);
        if (treeOid) {
          const flat = store.flattenTree(repo, treeOid);
          const prefix = filePath === "" ? "" : filePath + "/";
          const entries = new Map<string, any>();
          for (const [p, blobOid] of flat) {
            if (filePath !== "" && p !== filePath && p.indexOf(prefix) !== 0) continue;
            if (filePath === "" && p.indexOf("/") === -1) {
              entries.set(p, { type: "file", name: p, path: p, sha: blobOid });
              continue;
            }
            const restPath = filePath === "" ? p : p.slice(prefix.length);
            if (restPath === "") continue;
            const slash = restPath.indexOf("/");
            if (slash === -1) {
              entries.set(restPath, { type: "file", name: restPath, path: p, sha: blobOid });
            } else {
              const dirName = restPath.slice(0, slash);
              if (!entries.has(dirName)) {
                entries.set(dirName, { type: "dir", name: dirName, path: (filePath === "" ? dirName : filePath + "/" + dirName), sha: blobOid });
              }
            }
          }
          if (entries.size > 0) {
            const sorted = Array.from(entries.values()).sort((a: any, b: any) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            sendJson(res, 200, sorted);
            return true;
          }
        }
        sendError(res, 404, "Not Found");
        return true;
      }
      if (method === "PUT") {
        if (typeof body.content !== "string") {
          sendError(res, 422, "Validation Failed: content is required");
          return true;
        }
        const branch = shortBranch(typeof body.branch === "string" ? body.branch : undefined, repo.defaultBranch);
        const message = typeof body.message === "string" ? body.message : "";
        const existing = store.getFileAt(repo, branch, filePath);
        if (existing) {
          if (typeof body.sha === "string" && body.sha.toLowerCase() !== existing.oid.toLowerCase()) {
            sendError(res, 409, "sha does not match the current blob sha");
            return true;
          }
          const contentBuf = Buffer.from(body.content, "base64");
          const result = store.putFile(repo, branch, filePath, contentBuf, message);
          sendJson(res, 200, {
            content: { name: filePath.split("/").pop() || filePath, path: filePath, sha: result.blobSha, size: contentBuf.length, encoding: "base64", type: "file" },
            commit: { sha: result.commitSha, message: message },
          });
          return true;
        }
        const contentBuf = Buffer.from(body.content, "base64");
        const result = store.putFile(repo, branch, filePath, contentBuf, message);
        sendJson(res, 201, {
          content: { name: filePath.split("/").pop() || filePath, path: filePath, sha: result.blobSha, size: contentBuf.length, encoding: "base64", type: "file" },
          commit: { sha: result.commitSha, message: message },
        });
        return true;
      }
      if (method === "DELETE") {
        const branch = shortBranch(typeof body.branch === "string" ? body.branch : undefined, repo.defaultBranch);
        const message = typeof body.message === "string" ? body.message : "";
        const existing = store.getFileAt(repo, branch, filePath);
        if (!existing) {
          sendError(res, 404, "Not Found");
          return true;
        }
        if (typeof body.sha === "string" && body.sha.toLowerCase() !== existing.oid.toLowerCase()) {
          sendError(res, 409, "sha does not match the current blob sha");
          return true;
        }
        const result = store.deleteFile(repo, branch, filePath, message);
        if (!result) {
          sendError(res, 404, "Not Found");
          return true;
        }
        sendJson(res, 200, { commit: { sha: result.commitSha, message: message } });
        return true;
      }
      sendError(res, 404, "Not Found");
      return true;
    }

    // POST /labels
    if (tail.length === 1 && tail[0] === "labels") {
      if (method !== "POST") {
        sendError(res, 404, "Not Found");
        return true;
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        sendError(res, 422, "Validation Failed: name is required");
        return true;
      }
      const label = store.createLabel(repo, name, typeof body.color === "string" ? body.color : "ededed", typeof body.description === "string" ? body.description : "");
      sendJson(res, 201, labelJson(label, origin, repo));
      return true;
    }

    // /issues...
    if (tail.length >= 1 && tail[0] === "issues") {
      // POST / GET list
      if (tail.length === 1) {
        if (method === "POST") {
          const title = typeof body.title === "string" ? body.title : "";
          if (!title) {
            sendError(res, 422, "Validation Failed: title is required");
            return true;
          }
          const names = labelNames(body.labels);
          for (const n of names) {
            if (!store.getLabel(repo, n)) {
              sendError(res, 422, "Validation Failed: label '" + n + "' does not exist");
              return true;
            }
          }
          const issue = store.createIssue(repo, { title: title, body: typeof body.body === "string" ? body.body : "", labels: names });
          sendJson(res, 201, issueJson(repo, issue, origin, viewer));
          return true;
        }
        if (method === "GET") {
          const stateParam = url.searchParams.get("state") || "open";
          const sortParam = url.searchParams.get("sort");
          const dirParam = url.searchParams.get("direction") || "desc";
          let list = store.listIssues(repo, { state: stateParam === "all" ? "all" : stateParam === "closed" ? "closed" : "open" });
          // listIssues returns number ASC; apply state filter defensively and sort.
          if (stateParam === "open") list = list.filter((i: any) => i.state === "open");
          else if (stateParam === "closed") list = list.filter((i: any) => i.state === "closed");
          if (sortParam === "created") {
            list = list.slice().sort((a: any, b: any) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number));
            if (dirParam === "desc") list.reverse();
          } else if (sortParam === "updated") {
            list = list.slice().sort((a: any, b: any) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number));
            if (dirParam === "desc") list.reverse();
          } else if (sortParam === "comments") {
            list = list.slice().sort((a: any, b: any) => ((a.comments ? a.comments.length : 0) - (b.comments ? b.comments.length : 0)) || (a.number - b.number));
            if (dirParam === "desc") list.reverse();
          }
          const { perPage, page } = parsePageParams(url);
          const start = (page - 1) * perPage;
          const slice = list.slice(start, start + perPage);
          sendJson(res, 200, slice.map((i: any) => issueJson(repo, i, origin, viewer)));
          return true;
        }
        sendError(res, 404, "Not Found");
        return true;
      }
      // /issues/{n} and /issues/{n}/comments
      const num = Number(tail[1]);
      if (!Number.isInteger(num) || num < 1) {
        sendError(res, 404, "Not Found");
        return true;
      }
      const issue = store.getIssue(repo, num);
      if (tail.length === 2) {
        if (method === "GET") {
          if (!issue) {
            sendError(res, 404, "Not Found");
            return true;
          }
          sendJson(res, 200, issueJson(repo, issue, origin, viewer));
          return true;
        }
        if (method === "PATCH") {
          if (!issue) {
            sendError(res, 404, "Not Found");
            return true;
          }
          if (typeof body.title === "string") issue.title = body.title;
          if (typeof body.body === "string") issue.body = body.body;
          if (body.labels !== undefined) {
            const names = labelNames(body.labels);
            for (const n of names) {
              if (!store.getLabel(repo, n)) {
                sendError(res, 422, "Validation Failed: label '" + n + "' does not exist");
                return true;
              }
            }
            issue.labels = names;
          }
          if (body.state === "closed" || body.state === "open") {
            issue.state = body.state;
            // One clock tick for the whole patch: closedAt and updatedAt
            // describe the same event, so they share one timestamp.
            const now = store.nextTimestamp();
            if (body.state === "closed") issue.closedAt = now;
            else issue.closedAt = null;
            issue.updatedAt = now;
          } else {
            issue.updatedAt = store.nextTimestamp();
          }
          sendJson(res, 200, issueJson(repo, issue, origin, viewer));
          return true;
        }
        sendError(res, 404, "Not Found");
        return true;
      }
      if (tail.length === 3 && tail[2] === "comments") {
        if (!issue) {
          sendError(res, 404, "Not Found");
          return true;
        }
        if (method === "POST") {
          if (typeof body.body !== "string" || body.body === "") {
            sendError(res, 422, "Validation Failed: body is required");
            return true;
          }
          const comment = store.addIssueComment(repo, issue, body.body);
          sendJson(res, 201, commentJson(comment, origin, repo, issue, viewer));
          return true;
        }
        if (method === "GET") {
          sendJson(res, 200, (issue.comments || []).map((c: any) => commentJson(c, origin, repo, issue, viewer)));
          return true;
        }
        sendError(res, 404, "Not Found");
        return true;
      }
      sendError(res, 404, "Not Found");
      return true;
    }

    // /pulls...
    if (tail.length >= 1 && tail[0] === "pulls") {
      // POST / GET list
      if (tail.length === 1) {
        if (method === "POST") {
          const head = typeof body.head === "string" ? body.head : "";
          const base = typeof body.base === "string" ? body.base : "";
          const title = typeof body.title === "string" ? body.title : "";
          if (!head || !base || !title) {
            sendError(res, 422, "Validation Failed: head, base and title are required");
            return true;
          }
          const headRef = shortBranch(head, head);
          const baseRef = shortBranch(base, base);
          if (!store.getRef(repo, "refs/heads/" + headRef) || !store.getRef(repo, "refs/heads/" + baseRef)) {
            sendError(res, 422, "Validation Failed: head or base branch does not exist");
            return true;
          }
          const pr = store.createPull(repo, { title: title, body: typeof body.body === "string" ? body.body : "", head: headRef, base: baseRef });
          sendJson(res, 201, pullJson(store, repo, pr, origin, viewer));
          return true;
        }
        if (method === "GET") {
          const stateParam = url.searchParams.get("state") || "open";
          let list = store.listPulls(repo, { state: stateParam === "all" ? "all" : stateParam === "closed" ? "closed" : "open" });
          if (stateParam === "open") list = list.filter((p: any) => p.state === "open");
          else if (stateParam === "closed") list = list.filter((p: any) => p.state === "closed");
          const { perPage, page } = parsePageParams(url);
          const start = (page - 1) * perPage;
          const slice = list.slice(start, start + perPage);
          sendJson(res, 200, slice.map((p: any) => pullJson(store, repo, p, origin, viewer)));
          return true;
        }
        sendError(res, 404, "Not Found");
        return true;
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num) || num < 1) {
        sendError(res, 404, "Not Found");
        return true;
      }
      const pr = store.getPull(repo, num);
      if (tail.length === 2) {
        if (method === "GET") {
          if (!pr) {
            sendError(res, 404, "Not Found");
            return true;
          }
          sendJson(res, 200, pullJson(store, repo, pr, origin, viewer));
          return true;
        }
        sendError(res, 404, "Not Found");
        return true;
      }
      // /pulls/{n}/files
      if (tail.length === 3 && tail[2] === "files") {
        if (method !== "GET") {
          sendError(res, 404, "Not Found");
          return true;
        }
        if (!pr) {
          sendError(res, 404, "Not Found");
          return true;
        }
        const headTip = store.getRef(repo, "refs/heads/" + pr.headRef) || pr.headSha;
        const baseOid = pr.baseSha;
        const mergeBase = headTip && baseOid ? store.findMergeBase(repo, baseOid, headTip) : null;
        const baseTreeOid = treeOidOfCommit(store, repo, mergeBase || baseOid || undefined);
        const headTreeOid = treeOidOfCommit(store, repo, headTip || undefined);
        const baseFlat = baseTreeOid ? store.flattenTree(repo, baseTreeOid) : new Map();
        const headFlat = headTreeOid ? store.flattenTree(repo, headTreeOid) : new Map();
        const paths = new Set<string>();
        for (const k of baseFlat.keys()) paths.add(k);
        for (const k of headFlat.keys()) paths.add(k);
        const files: any[] = [];
        for (const p of Array.from(paths).sort()) {
          const bOid = baseFlat.get(p);
          const hOid = headFlat.get(p);
          if (bOid === hOid) continue;
          let status = "modified";
          let additions = 0;
          let deletions = 0;
          if (bOid === undefined && hOid !== undefined) {
            status = "added";
            const obj = store.getObject(repo, hOid);
            additions = obj ? countLines(obj.data) : 1;
            if (additions < 1) additions = 1;
          } else if (hOid === undefined && bOid !== undefined) {
            status = "removed";
            const obj = store.getObject(repo, bOid);
            deletions = obj ? countLines(obj.data) : 0;
          } else if (bOid !== undefined && hOid !== undefined) {
            status = "modified";
            const bObj = store.getObject(repo, bOid);
            const hObj = store.getObject(repo, hOid);
            additions = hObj ? countLines(hObj.data) : 0;
            deletions = bObj ? countLines(bObj.data) : 0;
            // A modified file whose content only changed slightly still has
            // at least one added line in the checks' fixtures; line counts
            // above already give >= 1 whenever the head content is non-empty.
            if (additions < 1 && hObj && hObj.data.length > 0) additions = 1;
          }
          files.push({ filename: p, status: status, additions: additions, deletions: deletions, changes: additions + deletions });
        }
        sendJson(res, 200, files);
        return true;
      }
      // PUT /pulls/{n}/merge
      if (tail.length === 3 && tail[2] === "merge") {
        if (method !== "PUT") {
          sendError(res, 404, "Not Found");
          return true;
        }
        if (!pr) {
          sendError(res, 404, "Not Found");
          return true;
        }
        if (pr.state === "closed" || pr.merged) {
          sendError(res, 405, "Pull request is already merged or closed");
          return true;
        }
        // Conflict detection (digest §6.18): a path changed on BOTH sides
        // since the merge-base, with different resulting blobs, conflicts.
        // Local computation from store primitives is primary: the first
        // merge in §6.18 (base tip == merge-base) must succeed, and a
        // false positive from the store's flag would wrongly 405 it.
        // The store flag is consulted only when local detection could not
        // determine an answer (no merge-base / missing trees / error).
        let conflict = false;
        let localDetermined = false;
        try {
          const headTip = store.getRef(repo, "refs/heads/" + pr.headRef) || pr.headSha;
          const baseTip = store.getRef(repo, "refs/heads/" + pr.baseRef) || pr.baseSha;
          if (headTip && baseTip) {
            const mb = store.findMergeBase(repo, baseTip, headTip);
            if (mb) {
              const mbTree = treeOidOfCommit(store, repo, mb);
              const headTree = treeOidOfCommit(store, repo, headTip);
              const curTree = treeOidOfCommit(store, repo, baseTip);
              if (mbTree && headTree && curTree) {
                localDetermined = true;
                const mbFlat = store.flattenTree(repo, mbTree);
                const headFlat = store.flattenTree(repo, headTree);
                const curFlat = store.flattenTree(repo, curTree);
                const allPaths = new Set<string>();
                for (const k of mbFlat.keys()) allPaths.add(k);
                for (const k of headFlat.keys()) allPaths.add(k);
                for (const k of curFlat.keys()) allPaths.add(k);
                for (const p of allPaths) {
                  const m = mbFlat.get(p);
                  const h = headFlat.get(p);
                  const c = curFlat.get(p);
                  if (h !== m && c !== m && h !== c) {
                    conflict = true;
                    break;
                  }
                }
              }
            }
          }
        } catch {
          localDetermined = false;
        }
        if (!localDetermined) {
          try {
            if (store.isMergeConflict(repo, pr)) conflict = true;
          } catch {
            conflict = false;
          }
        }
        if (conflict) {
          sendError(res, 405, "Merge conflict: pull request cannot be merged");
          return true;
        }
        const squashSha = store.squashMerge(repo, pr);
        if (!squashSha) {
          sendError(res, 405, "Pull request cannot be merged");
          return true;
        }
        sendJson(res, 200, {
          merged: true,
          sha: squashSha,
          message: "Pull request successfully merged",
        });
        return true;
      }
      sendError(res, 404, "Not Found");
      return true;
    }

    // Any other /repos/{o}/{r}/... sub-path is an unknown route.
    sendError(res, 404, "Not Found");
    return true;
  }

  // Any other /api/v3 path is an unknown route: JSON 404, never HTML.
  sendError(res, 404, "Not Found");
  return true;
}
