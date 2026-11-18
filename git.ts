// git.ts — Git smart-HTTP surface for the github-core-clone-01 entry.
// Routes: GET /{owner}/{repo}.git/info/refs, POST .../git-upload-pack (v2 + v0),
// POST .../git-receive-pack (v0 only). Implements the digest in
// ~/workspace/makefun/gh-specs/git.md (30 checks). Returns true when the
// request matched a git route (even for 404/401 answers), false otherwise.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER, ZERO_OID } from './store.ts';
import type { Ctx, GitObject, Repo } from './store.ts';
import { buildPack, parsePack, parsePktLines, pktFlush, pktLine, sha1Object } from './gitobj.ts';

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

function isAuthed(req: IncomingMessage, ctx: Ctx | undefined): boolean {
  if (ctx && typeof ctx.authed === 'boolean') return ctx.authed;
  const header = req.headers.authorization ?? (ctx ? ctx.authHeader : '') ?? '';
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const value = header.slice('Bearer '.length);
  if (!value) return false;
  if (token) return value === token;
  return true;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  send(res, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

/** Parse a tag object body for its target oid (first `object <oid>` line). */
function tagTarget(data: Buffer): string | null {
  const m = data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
  return m ? m[1] : null;
}

function headTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** Peeled commit oid for an annotated-tag ref, or null. */
function peeledOf(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return tagTarget(obj.data);
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs for advertisement/ls-refs, HEAD first, then sorted refs, with peeled tags. */
function allRefLines(repo: Repo, includeHead: boolean): RefLine[] {
  const lines: RefLine[] = [];
  const tip = headTip(repo);
  if (includeHead && tip) {
    lines.push({ oid: tip, name: 'HEAD' });
  }
  for (const { name, oid } of repoRefsSorted(repo)) {
    const peeled = peeledOf(repo, oid);
    lines.push(peeled ? { oid, name, peeled } : { oid, name });
  }
  return lines;
}

function repoRefsSorted(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const V0_UPLOAD_CAPS = 'side-band-64k shallow thin-pack ofs-delta multi_ack_detailed';
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

/** v0 advertisement body (upload-pack or receive-pack). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [];
  const preamble = `# service=${service}\n`;
  parts.push(pktLine(preamble));
  const capsBase = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const caps = `${capsBase} ${symref}`;
  const tip = headTip(repo);
  const refs = repoRefsSorted(repo);
  if (!tip && refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const emit = (line: string): void => {
      if (first) {
        parts.push(pktLine(`${line}\0${caps}\n`));
        first = false;
      } else {
        parts.push(pktLine(`${line}\n`));
      }
    };
    if (tip) emit(`${tip} HEAD`);
    for (const { name, oid } of refs) {
      emit(`${oid} ${name}`);
      const peeled = peeledOf(repo, oid);
      if (peeled) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 upload-pack capability advertisement body. */
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

// --- fetch object selection ---

/**
 * Objects the client already holds, given its `have` commits and its current
 * shallow boundaries. A shallow boundary commit is held *as a boundary*: the
 * client holds the commit and its tree, but NOT its parents or their closure
 * (a depth-1 clone holds only the tip). So the walk from a have stops at a
 * boundary commit instead of continuing to its parents. With no boundaries
 * this is the plain full closure.
 */
function heldClosureOids(store: Store, repo: Repo, haves: string[], shallowBoundaries: string[]): Set<string> {
  const boundarySet = new Set<string>(shallowBoundaries);
  const out = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (out.has(cur)) continue;
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    out.add(cur);
    if (obj.type === 'commit') {
      const info = store.parseCommit(obj.data);
      for (const oid of treeClosureOids(store, repo, info.tree)) out.add(oid);
      if (!boundarySet.has(cur)) {
        for (const p of info.parents) queue.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const oid of treeClosureOids(store, repo, cur)) out.add(oid);
    } else if (obj.type === 'tag') {
      const target = tagTarget(obj.data);
      if (target) queue.push(target);
    }
  }
  return out;
}

/** Tree closure oids for a tree oid (tree + subtrees + blobs). */
function treeClosureOids(store: Store, repo: Repo, treeOid: string): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [treeOid];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (out.has(cur)) continue;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') continue;
    out.add(cur);
    for (const e of store.parseTree(obj.data)) {
      if (e.mode === '40000') queue.push(e.oid);
      else out.add(e.oid);
    }
  }
  return out;
}

interface FetchPlan {
  /** Objects to send, in walk order (commits first, then their trees/blobs). */
  objects: { type: GitObject['type']; data: Buffer }[];
  /** New shallow boundary commits (generation == depth-1 with parents cut off). */
  shallow: string[];
  /** Old shallow boundaries whose parent is now delivered. */
  unshallow: string[];
}

/**
 * Real want/have negotiation.
 * - No depth: walk wants, stop at haves and their ancestors (never re-send them).
 * - Depth d: only generations 0..d-1 below each want; haves are excluded as
 *   objects but traversal passes through them so a deepen can extend the boundary.
 */
function planFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
): FetchPlan {
  // Objects the client already holds: the have-closure, truncated at the
  // client's shallow boundaries (see heldClosureOids). Never re-send those.
  const haveClosure = heldClosureOids(store, repo, haves, shallowBoundaries);
  const selected = new Map<string, GitObject>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const boundarySet = new Set<string>(shallowBoundaries);

  const addObject = (oid: string): void => {
    if (haveClosure.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    if (!selected.has(oid)) selected.set(oid, obj);
  };

  // Queue of commits to consider, with their generation below a want.
  const queue: { oid: string; gen: number }[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      addObject(want);
      const target = tagTarget(obj.data);
      if (target) queue.push({ oid: target, gen: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, gen: 0 });
    } else if (obj.type === 'tree') {
      for (const oid of treeClosureOids(store, repo, want)) addObject(oid);
    } else {
      addObject(want);
    }
  }
  const visitedCommits = new Set<string>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (visitedCommits.has(oid)) continue;
    visitedCommits.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = store.parseCommit(obj.data);
    const isHeld = haveClosure.has(oid);
    const withinDepth = depth === null || gen < depth;
    if (withinDepth && !isHeld) {
      addObject(oid);
      for (const treeOid of treeClosureOids(store, repo, info.tree)) addObject(treeOid);
    }
    // Boundary bookkeeping for shallow responses.
    if (depth !== null && gen === depth - 1 && info.parents.length > 0) {
      if (withinDepth && !isHeld) shallow.push(oid);
    }
    if (boundarySet.has(oid) && info.parents.length > 0) {
      // Traversing past an old boundary un-shallows it when a parent is delivered.
      const parentDelivered = info.parents.some(
        (p) => depth !== null && gen + 1 < depth && !haveClosure.has(p),
      );
      if (parentDelivered && !unshallow.includes(oid)) unshallow.push(oid);
    }
    // Traverse parents.
    if (depth === null) {
      if (!isHeld) {
        for (const p of info.parents) queue.push({ oid: p, gen: gen + 1 });
      }
    } else if (gen + 1 < depth) {
      for (const p of info.parents) queue.push({ oid: p, gen: gen + 1 });
    }
  }
  // Deterministic pack order: commits first (by walk insertion), then the rest.
  const ordered: { type: GitObject['type']; data: Buffer }[] = [];
  const commits: { type: GitObject['type']; data: Buffer }[] = [];
  const rest: { type: GitObject['type']; data: Buffer }[] = [];
  for (const obj of selected.values()) {
    if (obj.type === 'commit') commits.push(obj);
    else rest.push(obj);
  }
  ordered.push(...commits, ...rest);
  return { objects: ordered, shallow, unshallow };
}

/** Split a buffer into sideband band-1 pkt-lines (each raw packet <= 65520 bytes). */
function sidebandPackets(payload: Buffer, band: number): Buffer[] {
  const out: Buffer[] = [];
  const chunkSize = 65515; // 1 band byte + 65515 = 65516 payload + 4 header = 65520
  for (let off = 0; off < payload.length; off += chunkSize) {
    const chunk = payload.subarray(off, Math.min(off + chunkSize, payload.length));
    const framed = Buffer.concat([Buffer.from([band]), chunk]);
    out.push(pktLine(framed));
  }
  if (payload.length === 0) {
    out.push(pktLine(Buffer.from([band])));
  }
  return out;
}

function dataLines(lines: string[]): Buffer[] {
  return lines.map((l) => pktLine(l));
}

// --- v2 handlers ---

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const tip = headTip(repo);
  const refs = repoRefsSorted(repo);
  // HEAD is only reported when no ref-prefix filter is in force: a prefix
  // filter (e.g. refs/heads/) must not leak HEAD into rawRefs, and an empty
  // repo reports zero ref lines at all (clone-empty requires this).
  if (tip && args.prefixes.length === 0) {
    const attrs = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    parts.push(pktLine(`${tip} HEAD${attrs}\n`));
  }
  for (const { name, oid } of refs) {
    if (args.prefixes.length > 0 && !args.prefixes.some((p) => name.startsWith(p))) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function handleFetchV2(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const plan = planFetch(store, repo, args.wants, args.haves, args.shallow, args.depth);
  // acknowledgments section
  parts.push(pktLine('acknowledgments\n'));
  const knownHaves = args.haves.filter((h) => repo.objects.has(h));
  if (knownHaves.length > 0) {
    for (const h of knownHaves) parts.push(pktLine(`ACK ${h}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktFlush());
  // shallow-info section
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktFlush());
  }
  // packfile section (always present, even when empty)
  parts.push(pktLine('packfile\n'));
  const pack = buildPack(plan.objects);
  for (const pkt of sidebandPackets(pack, 1)) parts.push(pkt);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleFetchV0(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const plan = planFetch(store, repo, args.wants, args.haves, args.shallow, args.depth);
  const knownHaves = args.haves.filter((h) => repo.objects.has(h));
  if (knownHaves.length > 0) {
    for (const h of knownHaves) parts.push(pktLine(`ACK ${h}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  const pack = buildPack(plan.objects);
  for (const pkt of sidebandPackets(pack, 1)) parts.push(pkt);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// --- receive-pack ---

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const reportLines: string[] = [];
  let commands: PushCommand[] = [];
  let packBuf: Buffer | null = null;
  try {
    // Parse pkt-lines ONLY up to the first flush packet: everything after it
    // is the raw pack (binary, not pkt-framed). Parsing the whole body as
    // pkt-lines would choke on the pack bytes.
    const packets: (Buffer | 'flush' | 'delim' | 'end')[] = [];
    let off = 0;
    let packStart = body.length;
    let seenFlush = false;
    while (off < body.length) {
      if (off + 4 > body.length) throw new Error('truncated pkt-line header');
      const header = body.subarray(off, off + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
      const len = parseInt(header, 16);
      if (len === 0) {
        packets.push('flush');
        packStart = off + 4;
        seenFlush = true;
        break;
      } else if (len === 1) {
        packets.push('delim');
        off += 4;
      } else if (len === 2) {
        packets.push('end');
        off += 4;
      } else {
        if (len < 4 || len > 65520) throw new Error(`bad pkt-line length ${len}`);
        if (off + len > body.length) throw new Error('truncated pkt-line payload');
        packets.push(body.subarray(off + 4, off + len));
        off += len;
      }
    }
    if (!seenFlush) throw new Error('push has no flush packet');
    const dataPackets = packets.filter((p): p is Buffer => Buffer.isBuffer(p));
    commands = dataPackets.map((p, index) => {
      let text = p.toString('utf8');
      if (index === 0) {
        const nul = text.indexOf('\0');
        if (nul >= 0) text = text.slice(0, nul);
      }
      const parts = text.replace(/\n$/, '').split(' ');
      if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1])) {
        throw new Error('bad push command line');
      }
      return { oldOid: parts[0], newOid: parts[1], ref: parts[2] };
    });
    if (packStart < body.length) packBuf = body.subarray(packStart);
  } catch (err) {
    // Malformed command list: report unpack failure, apply nothing.
    reportLines.push('unpack error');
    const report = Buffer.concat([...dataLines(reportLines.map((l) => `${l}\n`)), pktFlush()]);
    return Buffer.concat([...sidebandPackets(report, 1), pktFlush()]);
  }

  // Unpack the pack (if any) before applying refs.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBuf && packBuf.length > 0) {
    try {
      const parsed = parsePack(packBuf);
      for (const obj of parsed.objects) {
        if (!repo.objects.has(obj.oid)) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
      }
    } catch {
      unpackOk = false;
      unpackDetail = 'error';
    }
  }

  const results: string[] = [];
  if (!unpackOk) {
    for (const cmd of commands) results.push(`ng ${cmd.ref} unpack failed`);
  } else {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current !== undefined && current === cmd.oldOid) {
          repo.refs.delete(cmd.ref);
          results.push(`ok ${cmd.ref}`);
        } else {
          results.push(`ng ${cmd.ref} stale info`);
        }
      } else if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          results.push(`ng ${cmd.ref} already exists`);
        } else if (!repo.objects.has(cmd.newOid)) {
          results.push(`ng ${cmd.ref} missing object`);
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          results.push(`ok ${cmd.ref}`);
        }
      } else {
        // Update: old must match, new must be a descendant of old.
        if (current === undefined || current !== cmd.oldOid) {
          results.push(`ng ${cmd.ref} stale info`);
        } else if (!repo.objects.has(cmd.newOid)) {
          results.push(`ng ${cmd.ref} missing object`);
        } else if (!store.isAncestor(repo, cmd.oldOid, cmd.newOid)) {
          results.push(`ng ${cmd.ref} non-fast-forward`);
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          results.push(`ok ${cmd.ref}`);
        }
      }
    }
  }
  reportLines.push(unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`);
  for (const r of results) reportLines.push(r);
  const report = Buffer.concat([...dataLines(reportLines.map((l) => `${l}\n`)), pktFlush()]);
  return Buffer.concat([...sidebandPackets(report, 1), pktFlush()]);
}

// --- main entry ---

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  ctx?: Ctx,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m) return false;
  const owner = decodeURIComponent(m[1]);
  const repoName = decodeURIComponent(m[2]);
  const endpoint = m[3];

  if (!isAuthed(req, ctx)) {
    sendText(res, 401, 'Unauthorized');
    return true;
  }

  const repo = store.getRepo(owner, repoName);
  // A repo under a different owner is 404, never 403.
  if (!repo || repo.owner !== owner) {
    sendText(res, 404, 'Not Found');
    return true;
  }

  try {
    if (method === 'GET' && endpoint === 'info/refs') {
      const service = url.searchParams.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        if (isV2) {
          send(res, 200, UPLOAD_AD_CT, v2Advertisement());
        } else {
          send(res, 200, UPLOAD_AD_CT, v0Advertisement(repo, 'git-upload-pack'));
        }
        return true;
      }
      if (service === 'git-receive-pack') {
        // Receive-pack is v0-only, unconditionally.
        send(res, 200, RECEIVE_AD_CT, v0Advertisement(repo, 'git-receive-pack'));
        return true;
      }
      sendText(res, 404, 'Not Found');
      return true;
    }

    if (method === 'POST' && endpoint === 'git-upload-pack') {
      const body = await readBody(req);
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (isV2) {
        const packets = parsePktLines(body);
        const lines = packets.filter((p): p is Buffer => Buffer.isBuffer(p)).map((p) => p.toString('utf8'));
        const commandLine = lines[0] ?? '';
        if (commandLine.startsWith('command=ls-refs')) {
          const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
          for (const line of lines.slice(1)) {
            const t = line.replace(/\n$/, '');
            if (t === 'peel') args.peel = true;
            else if (t === 'symrefs') args.symrefs = true;
            else if (t === 'unborn') args.unborn = true;
            else if (t.startsWith('ref-prefix ')) args.prefixes.push(t.slice('ref-prefix '.length));
          }
          send(res, 200, UPLOAD_RESULT_CT, handleLsRefs(repo, args));
          return true;
        }
        if (commandLine.startsWith('command=fetch')) {
          const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
          for (const line of lines.slice(1)) {
            const t = line.replace(/\n$/, '');
            if (t.startsWith('want ')) args.wants.push(t.slice(5).trim());
            else if (t.startsWith('have ')) args.haves.push(t.slice(5).trim());
            else if (t.startsWith('shallow ')) args.shallow.push(t.slice(8).trim());
            else if (t.startsWith('deepen ')) args.depth = Number.parseInt(t.slice(7).trim(), 10);
          }
          send(res, 200, UPLOAD_RESULT_CT, handleFetchV2(store, repo, args));
          return true;
        }
        sendText(res, 400, 'unknown command');
        return true;
      }
      // v0 fetch: two sections separated by flush.
      const packets = parsePktLines(body);
      const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
      let section = 0;
      for (const pkt of packets) {
        if (pkt === 'flush') {
          section = 1;
          continue;
        }
        if (typeof pkt !== 'string') {
          const t = pkt.toString('utf8').replace(/\n$/, '');
          if (t.startsWith('want ')) {
            const rest = t.slice(5).trim().split(' ')[0];
            args.wants.push(rest);
          } else if (t.startsWith('have ')) args.haves.push(t.slice(5).trim());
          else if (t.startsWith('shallow ')) args.shallow.push(t.slice(8).trim());
          else if (t.startsWith('deepen ')) args.depth = Number.parseInt(t.slice(7).trim(), 10);
        }
      }
      void section;
      send(res, 200, UPLOAD_RESULT_CT, handleFetchV0(store, repo, args));
      return true;
    }

    if (method === 'POST' && endpoint === 'git-receive-pack') {
      const body = await readBody(req);
      const out = handleReceivePack(store, repo, body);
      send(res, 200, RECEIVE_RESULT_CT, out);
      return true;
    }

    return false;
  } catch {
    // Malformed input must never crash the server or corrupt state.
    if (!res.headersSent) sendText(res, 400, 'Bad Request');
    else {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    return true;
  }
}

export { VIEWER, ZERO_OID, sha1Object };
