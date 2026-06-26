/**
 * The GitHub-side operations for "git repo = shared state" (roadmap Phase 4, live half): ensure the
 * repo exists, push VibeHard's build branch, open a PR (where gates run as required checks), and mint
 * the authenticated remote URL the local git seam (repo.ts) pushes through. Everything behind a
 * `GitProvider` interface so the turn-taking flow tests with a fake; the live impl is a thin adapter.
 *
 * Auth is a token-GETTER (() => Promise<token>), not a token — so a GitHub App installation token can
 * refresh transparently (app-auth.ts) and a legacy PAT is just `async () => pat`. Same seam, both work.
 */
export interface PullRequest {
  number: number;
  url: string;
}

export interface GitProvider {
  /** Ensure owner/name exists (create if missing); returns whether we created it. */
  ensureRepo(repo: string, opts?: { private?: boolean }): Promise<{ repo: string; created: boolean }>;
  /** Open a PR from VibeHard's build branch into the base — the human review + required-check surface. */
  openPullRequest(input: { repo: string; head: string; base: string; title: string; body: string }): Promise<PullRequest>;
  /** The remote URL to `git push` through, with a short-lived token embedded. NEVER logged. */
  authedRemoteUrl(repo: string): Promise<string>;
}

export interface GitHubProviderOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  /** the org/user to create repos under when a bare "name" (no owner) is given. */
  owner?: string;
}

/** Live GitHub adapter. `getToken` returns a fresh Bearer (App installation token or PAT). */
export function gitHubProvider(getToken: () => Promise<string>, opts: GitHubProviderOptions = {}): GitProvider {
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const api = async (method: string, path: string, body?: unknown) => {
    const token = await getToken();
    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : {}, text };
  };
  const splitOwner = (repo: string): { owner: string; name: string } => {
    const [a, b] = repo.split("/");
    return b ? { owner: a!, name: b } : { owner: opts.owner ?? "", name: a! };
  };
  return {
    async ensureRepo(repo, ensureOpts) {
      const { owner, name } = splitOwner(repo);
      // When an owner is known up front we can probe directly; otherwise we resolve
      // the real owner from the create/whoami response so the returned repo is a
      // valid "owner/name" (an empty owner yields "/name", which breaks every
      // downstream lookup — webhook routing, registry, remote URL).
      if (owner) {
        const got = await api("GET", `/repos/${owner}/${name}`);
        if (got.ok) return { repo: `${owner}/${name}`, created: false };
      } else {
        const me = await api("GET", "/user");
        const login = (me.json as { login?: string }).login;
        if (login) {
          const got = await api("GET", `/repos/${login}/${name}`);
          if (got.ok) return { repo: `${login}/${name}`, created: false };
        }
      }
      // create under a user or an org (the App's installation account)
      const created = await api("POST", owner ? `/orgs/${owner}/repos` : `/user/repos`, { name, private: ensureOpts?.private ?? true, auto_init: false });
      if (!created.ok) throw new Error(`create repo ${owner ? `${owner}/` : ""}${name}: ${created.status} ${created.text.slice(0, 200)}`);
      const fullName = (created.json as { full_name?: string }).full_name ?? `${owner}/${name}`;
      return { repo: fullName, created: true };
    },
    async openPullRequest(input) {
      const res = await api("POST", `/repos/${input.repo}/pulls`, { head: input.head, base: input.base, title: input.title, body: input.body });
      if (!res.ok) throw new Error(`open PR on ${input.repo}: ${res.status} ${res.text.slice(0, 200)}`);
      const pr = res.json as { number: number; html_url: string };
      return { number: pr.number, url: pr.html_url };
    },
    async authedRemoteUrl(repo) {
      const { owner, name } = splitOwner(repo);
      const token = await getToken();
      // x-access-token is GitHub's documented username for an installation token over HTTPS git.
      return `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
    },
  };
}

/** In-memory fake for the turn-taking tests: records calls, fabricates PR numbers, never hits GitHub. */
export function fakeGitProvider(seed: { existingRepos?: string[]; token?: string } = {}): GitProvider & { calls: string[]; prs: PullRequest[] } {
  const repos = new Set(seed.existingRepos ?? []);
  const calls: string[] = [];
  const prs: PullRequest[] = [];
  return {
    calls,
    prs,
    async ensureRepo(repo) {
      calls.push(`ensureRepo ${repo}`);
      const created = !repos.has(repo);
      repos.add(repo);
      return { repo, created };
    },
    async openPullRequest(input) {
      calls.push(`openPullRequest ${input.repo} ${input.head}->${input.base}`);
      const pr = { number: prs.length + 1, url: `https://github.com/${input.repo}/pull/${prs.length + 1}` };
      prs.push(pr);
      return pr;
    },
    async authedRemoteUrl(repo) {
      calls.push(`authedRemoteUrl ${repo}`);
      return `https://x-access-token:${seed.token ?? "faketoken"}@github.com/${repo}.git`;
    },
  };
}
