/* scripts/notion-sync.js */
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = process.env.NOTION_VERSION || "2025-09-03";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO = process.env.GITHUB_REPOSITORY; // "owner/repo"
const AFTER = process.env.GITHUB_SHA;
const BEFORE = process.env.GITHUB_EVENT_BEFORE || ""; // may be empty if manually run

if (!NOTION_TOKEN || !NOTION_DATABASE_ID || !GH_TOKEN || !GH_REPO || !AFTER) {
  console.error("Missing env vars. Need NOTION_TOKEN, NOTION_DATABASE_ID, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA.");
  process.exit(1);
}

const [owner, repo] = GH_REPO.split("/");

const PROPS = {
  title: process.env.NOTION_TITLE_PROP || "Name",
  path: process.env.NOTION_PATH_PROP || "Path",
  repo: process.env.NOTION_REPO_PROP || "Repo",
  url: process.env.NOTION_URL_PROP || "URL",
  sha: process.env.NOTION_SHA_PROP || "SHA",
};

async function notionFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Notion ${method} ${path} -> ${res.status} ${res.statusText}\n${text}`);
  }
  return res.json();
}

// Notion’s newer API model uses "data sources" under a database; fetch it when available. :contentReference[oaicite:6]{index=6}
async function getDataSourceId(databaseId) {
  const db = await notionFetch(`/databases/${databaseId}`);
  const ds = db?.data_sources?.[0];
  return ds?.id || null;
}

async function queryByPath({ dataSourceId, pathValue }) {
  const filter = {
    property: PROPS.path,
    rich_text: { equals: pathValue },
  };

  if (dataSourceId) {
    return notionFetch(`/data_sources/${dataSourceId}/query`, { method: "POST", body: { filter, page_size: 1 } });
  }
  return notionFetch(`/databases/${NOTION_DATABASE_ID}/query`, { method: "POST", body: { filter, page_size: 1 } });
}

async function createOrUpdate({ dataSourceId, pathValue, shaValue }) {
  const q = await queryByPath({ dataSourceId, pathValue });
  const existing = q.results?.[0];

  const fileName = pathValue.split("/").pop() || pathValue;
  const title = fileName.replace(/\.[^.]+$/, "");

  const url = `https://github.com/${owner}/${repo}/blob/${process.env.GITHUB_REF_NAME || "main"}/${pathValue}`;

  const properties = {
    [PROPS.title]: { title: [{ text: { content: title } }] },
    [PROPS.path]: { rich_text: [{ text: { content: pathValue } }] },
    [PROPS.repo]: { rich_text: [{ text: { content: `${owner}/${repo}` } }] },
    [PROPS.url]: { url },
    [PROPS.sha]: { rich_text: [{ text: { content: shaValue } }] },
  };

  if (!existing) {
    // Create page in database/data source. :contentReference[oaicite:7]{index=7}
    const parent = dataSourceId
      ? { type: "data_source_id", data_source_id: dataSourceId }
      : { database_id: NOTION_DATABASE_ID };

    await notionFetch(`/pages`, { method: "POST", body: { parent, properties } });
    return { action: "created", path: pathValue };
  }

  // If SHA unchanged, skip update.
  const currentSha = existing.properties?.[PROPS.sha]?.rich_text?.[0]?.plain_text || "";
  if (currentSha === shaValue) return { action: "skipped", path: pathValue };

  await notionFetch(`/pages/${existing.id}`, { method: "PATCH", body: { properties } });
  return { action: "updated", path: pathValue };
}

async function run() {
  // Changed docs since last push (fast, avoids scanning entire repo)
  // If BEFORE is empty (manual run), fall back to scanning whole repo tree (not implemented here).
  if (!BEFORE) {
    console.log("No BEFORE SHA (manual run). Re-run via push, or extend script to do full tree scan.");
    process.exit(0);
  }

  // Get changed files from git diff
  const { execSync } = await import("node:child_process");
  const diff = execSync(`git diff --name-status ${BEFORE} ${AFTER} -- docs/adr/`, { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);

  const candidates = diff
    .map((line) => {
      const [status, file] = line.split(/\s+/);
      return { status, file };
    })
    .filter((x) => x.file && x.file.startsWith("docs/adr/") && (x.file.endsWith(".md") || x.file.endsWith(".mdc")));

  if (candidates.length === 0) {
    console.log("No docs changes.");
    return;
  }

  const dataSourceId = await getDataSourceId(NOTION_DATABASE_ID);

  // For each changed file, compute blob SHA by asking GitHub contents API (simple and ok for changed-only)
  for (const { status, file } of candidates) {
    if (status === "D") {
      // Optional: query by Path and archive the page instead of deleting
      console.log(`deleted: ${file} (not archiving in this minimal script)`);
      continue;
    }

    const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file}?ref=${AFTER}`, {
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        Accept: "application/vnd.github+json",
      },
    });

    if (!ghRes.ok) {
      console.log(`skip ${file}: cannot read contents metadata (${ghRes.status})`);
      continue;
    }

    const meta = await ghRes.json();
    const sha = meta.sha || "";

    const r = await createOrUpdate({ dataSourceId, pathValue: file, shaValue: sha });
    console.log(`${r.action}: ${r.path}`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
