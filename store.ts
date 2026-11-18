// store.ts — shared in-memory store for the github-core-clone-01 entry.
// Implements the contract in ~/workspace/makefun/gh-specs/store-api.md exactly:
// entities, Store class, monotonic timestamps, global ids, ancestry, squash
// merge, conflict detection, and file-at-ref commit machinery.
import { sha1Object } from './gitobj.ts';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export const VIEWER: User = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export interface Ctx {
  viewer: User;
  authHeader: string;
  authed: boolean;
}

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: User;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: User;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Pull {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  headRef: string;
  baseRef: string;
  headSha: string | null;
  baseSha: string | null;
  mergeCommitSha: string | null;
  user: User;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, Pull>;
  nextPull: number;
  labels: Map<string, Label>;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

/** Git tree sort: byte order of the name, a directory compared as if its name ended in '/'. */
export function compareTreeNames(a: string, aIsDir: boolean, b: string, bIsDir: boolean): number {
  const an = aIsDir ? `${a}/` : a;
  const bn = bIsDir ? `${b}/` : b;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((x, y) =>
    compareTreeNames(x.name, x.mode === '40000', y.name, y.mode === '40000'),
  );
}

export class Store {
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextGlobalId: number;
  private nextMs: number;

  constructor() {
    this.repos = new Map<string, Repo>();
    this.nextRepoId = 1;
    this.nextGlobalId = 1;
    const base = process.env.MAKEFUN_TRIAL_NOW ?? '2025-01-01T00:00:00Z';
    const parsed = Date.parse(base);
    this.nextMs = Number.isFinite(parsed) ? parsed : Date.parse('2025-01-01T00:00:00Z');
  }

  // --- repos ---

  createRepo(
    owner: string,
    name: string,
    opts: { description?: string; private?: boolean; defaultBranch?: string } = {},
  ): Repo | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const ts = this.nextTimestamp();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      fullName: key,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: ts,
      updatedAt: ts,
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      issues: new Map<number, Issue>(),
      nextIssue: 1,
      pulls: new Map<number, Pull>(),
      nextPull: 1,
      labels: new Map<string, Label>(),
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  // --- git objects ---

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = sha1Object(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  parseCommit(data: Buffer): CommitInfo {
    const text = data.toString('utf8');
    const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message: '' };
    const blank = text.indexOf('\n\n');
    const header = blank >= 0 ? text.slice(0, blank) : text;
    info.message = blank >= 0 ? text.slice(blank + 2) : '';
    for (const line of header.split('\n')) {
      if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) info.author = line.slice(7);
      else if (line.startsWith('committer ')) info.committer = line.slice(10);
    }
    return info;
  }

  parseTree(data: Buffer): TreeEntry[] {
    const entries: TreeEntry[] = [];
    let off = 0;
    while (off < data.length) {
      const space = data.indexOf(0x20, off);
      if (space < 0) break;
      const mode = data.subarray(off, space).toString('ascii');
      const nul = data.indexOf(0x00, space + 1);
      if (nul < 0 || nul + 21 > data.length) break;
      const name = data.subarray(space + 1, nul).toString('utf8');
      const oid = data.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, oid });
      off = nul + 21;
    }
    return entries;
  }

  buildCommit(info: { tree: string; parents: string[]; author: string; committer: string; message: string }): Buffer {
    let out = `tree ${info.tree}\n`;
    for (const p of info.parents) out += `parent ${p}\n`;
    out += `author ${info.author}\n`;
    out += `committer ${info.committer}\n`;
    out += '\n';
    out += info.message.endsWith('\n') ? info.message : `${info.message}\n`;
    return Buffer.from(out, 'utf8');
  }

  buildTree(entries: TreeEntry[]): Buffer {
    const parts: Buffer[] = [];
    for (const e of sortTreeEntries(entries)) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.oid, 'hex'));
    }
    return Buffer.concat(parts);
  }

  // --- ancestry ---

  /** All commit oids reachable from `oid` (including `oid` itself), parents-first order. */
  ancestorsOf(repo: Repo, oid: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const stack: string[] = [oid];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      out.push(cur);
      const info = this.parseCommit(obj.data);
      for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]);
    }
    return out;
  }

  isAncestor(repo: Repo, ancestorOid: string, oid: string): boolean {
    if (ancestorOid === oid) return true;
    if (!isOid(ancestorOid) || !isOid(oid)) return false;
    const seen = new Set<string>();
    const stack: string[] = [oid];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === ancestorOid) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      const info = this.parseCommit(obj.data);
      for (const p of info.parents) stack.push(p);
    }
    return false;
  }

  findMergeBase(repo: Repo, a: string, b: string): string | null {
    if (!isOid(a) || !isOid(b)) return null;
    if (a === b) return a;
    const ancestorsA = new Set<string>(this.ancestorsOf(repo, a));
    // BFS from b by generation so the first common ancestor is the nearest one.
    const seen = new Set<string>();
    const queue: string[] = [b];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      if (ancestorsA.has(cur)) return cur;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      const info = this.parseCommit(obj.data);
      for (const p of info.parents) queue.push(p);
    }
    return null;
  }

  flattenTree(repo: Repo, treeOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (tree: string, prefix: string): void => {
      const obj = repo.objects.get(tree);
      if (!obj || obj.type !== 'tree') return;
      for (const e of this.parseTree(obj.data)) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, e.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  listRefs(repo: Repo): { name: string; oid: string }[] {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  getRef(repo: Repo, refname: string): string | undefined {
    return repo.refs.get(refname);
  }

  setRef(repo: Repo, refname: string, oid: string): void {
    repo.refs.set(refname, oid);
  }

  deleteRef(repo: Repo, refname: string): boolean {
    return repo.refs.delete(refname);
  }

  // --- issues / labels / pulls ---

  createLabel(repo: Repo, name: string, color?: string, description?: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = {
      id: this.nextGlobalId,
      name,
      color: color ?? '000000',
      description: description ?? '',
    };
    this.nextGlobalId += 1;
    repo.labels.set(name, label);
    return label;
  }

  getLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.get(name);
  }

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue {
    const ts = this.nextTimestamp();
    const issue: Issue = {
      id: this.nextGlobalId,
      number: repo.nextIssue,
      repoId: repo.id,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...(input.labels ?? [])],
      user: VIEWER,
      createdAt: ts,
      updatedAt: ts,
      closedAt: null,
      comments: [],
    };
    this.nextGlobalId += 1;
    repo.nextIssue += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  listIssues(
    repo: Repo,
    opts: { state?: 'open' | 'closed' | 'all'; sort?: 'created' | 'updated' | 'comments'; direction?: 'asc' | 'desc' } = {},
  ): Issue[] {
    // Returns issues in number ASC order; the caller sorts/filters per its own digest.
    const all = [...repo.issues.values()].sort((a, b) => a.number - b.number);
    if (opts.state && opts.state !== 'all') return all.filter((i) => i.state === opts.state);
    return all;
  }

  addIssueComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const ts = this.nextTimestamp();
    const comment: IssueComment = {
      id: this.nextGlobalId,
      body,
      user: VIEWER,
      createdAt: ts,
      updatedAt: ts,
    };
    this.nextGlobalId += 1;
    issue.comments.push(comment);
    issue.updatedAt = ts;
    return comment;
  }

  private tipOf(repo: Repo, branchShort: string): string | null {
    return repo.refs.get(`refs/heads/${branchShort}`) ?? null;
  }

  private refreshPullShas(repo: Repo, pr: Pull): void {
    pr.headSha = this.tipOf(repo, pr.headRef);
    pr.baseSha = this.tipOf(repo, pr.baseRef);
  }

  createPull(repo: Repo, input: { title: string; body?: string; head: string; base: string }): Pull {
    const ts = this.nextTimestamp();
    const pr: Pull = {
      id: this.nextGlobalId,
      number: repo.nextPull,
      repoId: repo.id,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergeable: true,
      headRef: input.head,
      baseRef: input.base,
      headSha: null,
      baseSha: null,
      mergeCommitSha: null,
      user: VIEWER,
      createdAt: ts,
      updatedAt: ts,
      closedAt: null,
      mergedAt: null,
    };
    this.nextGlobalId += 1;
    repo.nextPull += 1;
    repo.pulls.set(pr.number, pr);
    this.refreshPullShas(repo, pr);
    if (pr.headSha && pr.baseSha) pr.mergeable = !this.isMergeConflict(repo, pr);
    return pr;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    const pr = repo.pulls.get(number);
    if (pr) this.refreshPullShas(repo, pr);
    return pr;
  }

  listPulls(repo: Repo, opts: { state?: 'open' | 'closed' | 'all' } = {}): Pull[] {
    const all = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
    for (const pr of all) this.refreshPullShas(repo, pr);
    if (opts.state && opts.state !== 'all') return all.filter((p) => p.state === opts.state);
    return all;
  }

  squashMerge(repo: Repo, pr: Pull): string | null {
    if (pr.state === 'closed' || pr.merged) return null;
    const baseTip = this.tipOf(repo, pr.baseRef);
    const headTip = this.tipOf(repo, pr.headRef) ?? pr.headSha;
    if (!baseTip || !headTip) return null;
    const headObj = repo.objects.get(headTip);
    if (!headObj || headObj.type !== 'commit') return null;
    const headInfo = this.parseCommit(headObj.data);
    const ts = this.nextTimestamp();
    const epoch = Math.floor(Date.parse(ts) / 1000);
    const ident = `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
    const data = this.buildCommit({
      tree: headInfo.tree,
      parents: [baseTip],
      author: ident,
      committer: ident,
      message: `Merge pull request #${pr.number} from ${pr.headRef}`,
    });
    const oid = this.putObject(repo, 'commit', data);
    this.setRef(repo, `refs/heads/${pr.baseRef}`, oid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergeable = false;
    pr.mergeCommitSha = oid;
    pr.mergedAt = ts;
    pr.closedAt = ts;
    pr.updatedAt = ts;
    pr.baseSha = oid;
    return oid;
  }

  isMergeConflict(repo: Repo, pr: Pull): boolean {
    const headTip = this.tipOf(repo, pr.headRef) ?? pr.headSha;
    const baseTip = this.tipOf(repo, pr.baseRef) ?? pr.baseSha;
    if (!headTip || !baseTip) return false;
    const headObj = repo.objects.get(headTip);
    const baseObj = repo.objects.get(baseTip);
    if (!headObj || !baseObj || headObj.type !== 'commit' || baseObj.type !== 'commit') return false;
    const mergeBase = this.findMergeBase(repo, headTip, baseTip);
    const baseTree = mergeBase
      ? ((): string | null => {
          const mb = repo.objects.get(mergeBase);
          if (!mb || mb.type !== 'commit') return null;
          return this.parseCommit(mb.data).tree;
        })()
      : null;
    const baseFlat = baseTree ? this.flattenTree(repo, baseTree) : new Map<string, string>();
    const headFlat = this.flattenTree(repo, this.parseCommit(headObj.data).tree);
    const baseBranchFlat = this.flattenTree(repo, this.parseCommit(baseObj.data).tree);
    const changedOn = (side: Map<string, string>): Map<string, string | undefined> => {
      const changed = new Map<string, string | undefined>();
      const paths = new Set<string>([...baseFlat.keys(), ...side.keys()]);
      for (const p of paths) {
        const before = baseFlat.get(p);
        const after = side.get(p);
        if (before !== after) changed.set(p, after);
      }
      return changed;
    };
    const headChanged = changedOn(headFlat);
    const baseChanged = changedOn(baseBranchFlat);
    for (const [path, headOid] of headChanged) {
      if (baseChanged.has(path) && baseChanged.get(path) !== headOid) return true;
    }
    return false;
  }

  // --- contents ---

  /** Resolve a ref (branch short name, full refname, "HEAD", or commit oid) to a commit oid. */
  resolveRefToCommit(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
    const asHead = repo.refs.get(`refs/heads/${ref}`);
    if (asHead) return asHead;
    const asTag = repo.refs.get(`refs/tags/${ref}`);
    if (asTag) {
      const obj = repo.objects.get(asTag);
      if (obj && obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) return m[1];
      }
      return asTag;
    }
    if (isOid(ref)) {
      const obj = repo.objects.get(ref);
      if (obj && obj.type === 'commit') return ref;
      if (obj && obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) return m[1];
      }
    }
    return null;
  }

  getFileAt(repo: Repo, ref: string, path: string): { oid: string; content: Buffer; mode: string } | null {
    const commitOid = this.resolveRefToCommit(repo, ref);
    if (!commitOid) return null;
    const commitObj = repo.objects.get(commitOid);
    if (!commitObj || commitObj.type !== 'commit') return null;
    const treeOid = this.parseCommit(commitObj.data).tree;
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return null;
    let currentTree = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const treeObj = repo.objects.get(currentTree);
      if (!treeObj || treeObj.type !== 'tree') return null;
      const entry = this.parseTree(treeObj.data).find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') return null;
        const blob = repo.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { oid: entry.oid, content: blob.data, mode: entry.mode };
      }
      if (entry.mode !== '40000') return null;
      currentTree = entry.oid;
    }
    return null;
  }

  /** Rebuild the tree for `flat` (path -> blob oid) bottom-up. */
  private buildTreeFromFlat(repo: Repo, flat: Map<string, string>): string {
    const buildLevel = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, oid] of flat) {
        if (prefix && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix ? path.slice(prefix.length + 1) : path;
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: '100644', name: rest, oid });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      for (const dir of dirs) {
        const sub = buildLevel(prefix ? `${prefix}/${dir}` : dir);
        entries.push({ mode: '40000', name: dir, oid: sub });
      }
      return this.putObject(repo, 'tree', this.buildTree(entries));
    };
    return buildLevel('');
  }

  private commitFileChange(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitSha: string; blobSha: string } | null {
    const branchName = branch && branch.length > 0 ? branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branchName}`) ?? null;
    let flat = new Map<string, string>();
    let parentTree = '';
    if (tip) {
      const tipObj = repo.objects.get(tip);
      if (!tipObj || tipObj.type !== 'commit') return null;
      parentTree = this.parseCommit(tipObj.data).tree;
      flat = this.flattenTree(repo, parentTree);
    }
    let blobSha = '';
    if (content !== null) {
      blobSha = this.putObject(repo, 'blob', content);
      flat.set(path, blobSha);
    } else {
      if (!flat.has(path)) return null;
      flat.delete(path);
    }
    const newTree = this.buildTreeFromFlat(repo, flat);
    const ts = this.nextTimestamp();
    const epoch = Math.floor(Date.parse(ts) / 1000);
    const ident = `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
    const data = this.buildCommit({
      tree: newTree,
      parents: tip ? [tip] : [],
      author: ident,
      committer: ident,
      message,
    });
    const commitSha = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branchName}`, commitSha);
    repo.updatedAt = ts;
    return { commitSha, blobSha };
  }

  putFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
    const result = this.commitFileChange(repo, branch, path, content, message);
    if (!result) throw new Error('putFile failed: branch tip is not a commit');
    return result;
  }

  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const result = this.commitFileChange(repo, branch, path, null, message);
    if (!result) return null;
    return { commitSha: result.commitSha };
  }

  // --- ids / time ---

  nextTimestamp(): string {
    const ts = new Date(this.nextMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    this.nextMs += 1000;
    return ts;
  }

  globalId(kind: 'Issue' | 'PullRequest' | 'Repository', repoId: number, number: number): string {
    return Buffer.from(`${kind}:${repoId}:${number}`, 'utf8').toString('base64url');
  }

  parseGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
    try {
      const text = Buffer.from(id, 'base64url').toString('utf8');
      const parts = text.split(':');
      if (parts.length !== 3) return null;
      const repoId = Number(parts[1]);
      const number = Number(parts[2]);
      if (!Number.isInteger(repoId) || !Number.isInteger(number)) return null;
      return { kind: parts[0], repoId, number };
    } catch {
      return null;
    }
  }
}
