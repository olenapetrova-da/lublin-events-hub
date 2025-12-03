/* scripts/notion-sync.js */
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = process.env.NOTION_VERSION || "2025-09-03";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO = process.env.GITHUB_REPOSITORY; // "owner/repo"

/* adding a possibility of a manual full sync - Replace how BEFORE is set - START */ 
const fs = require("node:fs");

const AFTER = process.env.GITHUB_SHA;
const FULL_SYNC = process.env.FULL_SYNC === "1";
const DOCS_ROOT = (process.env.DOCS_ROOT || "docs/adr/").replace(/\\/g, "/").replace(/^\.?\//, "");

const EVENT_PATH = process.env.GITHUB_EVENT_PATH || "";
let BEFORE = "";
try {
  if (EVENT_PATH && fs.existsSync(EVENT_PATH)) {
    const payload = JSON.parse(fs.readFileSync(EVENT_PATH, "utf8"));
    BEFORE = payload.before || "";
  }
} catch {
  BEFORE = "";
}
/* adding a possibility of a manual full sync - Replace how BEFORE is set - END */ 

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
/* Replace the “manual run” early-exit block with a full-sync branch START */
    const { execSync } = require("node:child_process");

  // FULL_SYNC path (initial sync) OR when we don't have a meaningful BEFORE SHA
  if (FULL_SYNC || !BEFORE) {
    const out = execSync(`git ls-tree -r ${AFTER} -- ${DOCS_ROOT}`, { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);

    const files = out
      .map((line) => {
        // Format: "<mode> <type> <sha>\t<path>"
        const [left, path] = line.split("\t");
        const parts = left.split(" ");
        const type = parts[1];
        const sha = parts[2];
        return { type, sha, path };
      })
      .filter((x) => x.type === "blob" && x.path.startsWith(DOCS_ROOT) && (x.path.endsWith(".md") || x.path.endsWith(".mdc")));

    if (files.length === 0) {
      console.log(`No files found under ${DOCS_ROOT}`);
      return;
    }

    const dataSourceId = await getDataSourceId(NOTION_DATABASE_ID);

    for (const f of files) {
      const r = await createOrUpdate({ dataSourceId, pathValue: f.path, shaValue: f.sha });
      console.log(`${r.action}: ${r.path}`);
    }

    return;
  }
/* Replace the “manual run” early-exit block with a full-sync branch END */

  // Get changed files from git diff

  const diff = execSync(`git diff --name-status ${BEFORE} ${AFTER} -- ${DOCS_ROOT}`, { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);

  const candidates = diff
  .map((line) => {
    const parts = line.split(/\s+/);
    const status = parts[0];

    // Rename/Copy: "R100 old new" or "C100 old new"
    if (status.startsWith("R") || status.startsWith("C")) {
      return { status, oldFile: parts[1], file: parts[2] };
    }

    // Add/Modify/Delete: "A file", "M file", "D file"
    return { status, file: parts[1] };
  })
  .filter((x) => {
    const p = x.file || "";
    const old = x.oldFile || "";
    const relevant = p.startsWith(DOCS_ROOT) ? p : (old.startsWith(DOCS_ROOT) ? old : "");
    return relevant && (relevant.endsWith(".md") || relevant.endsWith(".mdc"));
  });


  if (candidates.length === 0) {
    console.log("No docs changes.");
    return;
  }

  const dataSourceId = await getDataSourceId(NOTION_DATABASE_ID);

  // Process deleted files - Start
  async function archiveByPath(pathValue) {
  const q = await queryByPath({ dataSourceId, pathValue });
  const existing = q.results?.[0];
  if (!existing) return { action: "missing", path: pathValue };

  await notionFetch(`/pages/${existing.id}`, { method: "PATCH", body: { archived: true } });
  return { action: "archived", path: pathValue };
}
// Process deleted files - End

// Process renamed files - Start
async function renameByPath(oldPath, newPath, shaValue) {
  const q = await queryByPath({ dataSourceId, pathValue: oldPath });
  const existing = q.results?.[0];

  // If we can't find the old row, just upsert the new path
  if (!existing) {
    return createOrUpdate({ dataSourceId, pathValue: newPath, shaValue });
  }

  const fileName = newPath.split("/").pop() || newPath;
  const title = fileName.replace(/\.[^.]+$/, "");
  const url = `https://github.com/${owner}/${repo}/blob/${process.env.GITHUB_REF_NAME || "main"}/${newPath}`;

  const properties = {
    [PROPS.title]: { title: [{ text: { content: title } }] },
    [PROPS.path]: { rich_text: [{ text: { content: newPath } }] },
    [PROPS.repo]: { rich_text: [{ text: { content: `${owner}/${repo}` } }] },
    [PROPS.url]: { url },
    [PROPS.sha]: { rich_text: [{ text: { content: shaValue } }] },
  };

  await notionFetch(`/pages/${existing.id}`, { method: "PATCH", body: { properties } });
  return { action: "renamed", path: newPath };
}
// Process renamed files - End

  // For each changed file, compute blob SHA by asking GitHub contents API (simple and ok for changed-only)
  for (const item of candidates) {
  const status = item.status || "";
  const file = item.file;
  const oldFile = item.oldFile;

  // Deleted file -> archive the Notion row (by Path)
  if (status === "D") {
    const r = await archiveByPath(file);
    console.log(`${r.action}: ${r.path}`);
    continue;
  }

  // Renamed file -> update existing Notion row (keep your status fields)
  if (status.startsWith("R") && oldFile) {
    // If moved out of DOCS_ROOT, archive the old one
    if (!file || !file.startsWith(DOCS_ROOT)) {
      const r = await archiveByPath(oldFile);
      console.log(`${r.action}: ${r.path}`);
      continue;
    }

    let sha = "";
    try {
      sha = execSync(`git rev-parse ${AFTER}:${file}`, { encoding: "utf8" }).trim();
    } catch {
      console.log(`skip ${file}: cannot resolve blob sha at ${AFTER}`);
      continue;
    }

    const r = await renameByPath(oldFile, file, sha);
    console.log(`${r.action}: ${r.path}`);
    continue;
  }

  // Normal add/modify/copy
  if (!file || !file.startsWith(DOCS_ROOT)) continue;

  let sha = "";
  try {
    sha = execSync(`git rev-parse ${AFTER}:${file}`, { encoding: "utf8" }).trim();
  } catch {
    console.log(`skip ${file}: cannot resolve blob sha at ${AFTER}`);
    continue;
  }

  const r = await createOrUpdate({ dataSourceId, pathValue: file, shaValue: sha });
  console.log(`${r.action}: ${r.path}`);
}

}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});