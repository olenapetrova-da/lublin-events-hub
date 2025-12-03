/* scripts/notion-sync.js
 *
 * Sync ADR docs from GitHub -> Notion database.
 * - Uses DOCS_ROOT (default: docs/adr/) as source.
 * - Supports FULL_SYNC=1 to resync all ADRs under DOCS_ROOT.
 * - Parses ADR metadata from markdown:
 *    # ADR-0005 – Data model — raw_events → events
 *    *Status:* Accepted (concept; implementation differs)
 *    *Date:* 2025-11-10
 *    *Applies to:* LEHv1, LEHv2, S1
 *    *Superseded by:* ADR-0015
 *
 * Notion properties (defaults, override via env if needed):
 *   Name              (title)  -> PROPS.title
 *   Path              (text)   -> PROPS.path
 *   Repo              (text)   -> PROPS.repo
 *   URL               (url)    -> PROPS.url
 *   SHA               (text)   -> PROPS.sha
 *   ADR ID            (text)   -> PROPS.adrId
 *   Title             (text)   -> PROPS.adrTitle
 *   Date              (date)   -> PROPS.adrDate
 *   Status            (select) -> PROPS.adrStatus
 *   Superseded by     (text)   -> PROPS.adrSupersededBy
 *   Applies to (text) (text)   -> PROPS.adrAppliesText
 *   Applies to        (relation to LEH versions DB) -> PROPS.adrAppliesRel
 *
 * Additional env:
 *   NOTION_LEH_VERSIONS_DB_ID          - Notion DB id for "LEH versions" database.
 *   NOTION_LEH_VERSIONS_NAME_PROP      - Name property in that DB (default "Name").
 */

const fs = require("node:fs");
const { execSync } = require("node:child_process");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = process.env.NOTION_VERSION || "2025-09-03";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO = process.env.GITHUB_REPOSITORY; // "owner/repo"
const GH_REF_NAME = process.env.GITHUB_REF_NAME || "main";

const AFTER = process.env.GITHUB_SHA;
const FULL_SYNC = process.env.FULL_SYNC === "1";
const DOCS_ROOT = (process.env.DOCS_ROOT || "docs/adr/")
  .replace(/\\/g, "/")
  .replace(/^\.?\//, "");

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

if (!NOTION_TOKEN || !NOTION_DATABASE_ID || !GH_TOKEN || !GH_REPO || !AFTER) {
  console.error(
    "Missing env vars. Need NOTION_TOKEN, NOTION_DATABASE_ID, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA."
  );
  process.exit(1);
}

const NOTION_LEH_VERSIONS_DB_ID =
  process.env.NOTION_LEH_VERSIONS_DB_ID || "";
const VERSIONS_NAME_PROP =
  process.env.NOTION_LEH_VERSIONS_NAME_PROP || "Name";

const [owner, repo] = GH_REPO.split("/");

const PROPS = {
  title: process.env.NOTION_TITLE_PROP || "Name",
  path: process.env.NOTION_PATH_PROP || "Path",
  repo: process.env.NOTION_REPO_PROP || "Repo",
  url: process.env.NOTION_URL_PROP || "URL",
  sha: process.env.NOTION_SHA_PROP || "SHA",

  adrId: process.env.NOTION_ADR_ID_PROP || "ADR ID",
  adrTitle: process.env.NOTION_ADR_TITLE_PROP || "Title",
  adrDate: process.env.NOTION_ADR_DATE_PROP || "Date",
  adrStatus: process.env.NOTION_ADR_STATUS_PROP || "Status",
  adrSupersededBy:
    process.env.NOTION_ADR_SUP_PROP || "Superseded by",
  adrAppliesText:
    process.env.NOTION_ADR_APPLIES_TEXT_PROP ||
    "Applies to (text)",
  adrAppliesRel:
    process.env.NOTION_ADR_APPLIES_REL_PROP || "Applies to",
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
    throw new Error(
      `Notion ${method} ${path} -> ${res.status} ${res.statusText}\n${text}`
    );
  }
  return res.json();
}

// New API model: databases can have data_sources; use first when present.
async function getDataSourceId(databaseId) {
  const db = await notionFetch(`/databases/${databaseId}`);
  const ds = db?.data_sources?.[0];
  return ds?.id || null;
}

// Fetch all "LEH versions" pages to build a name -> pageId map.
async function fetchVersionsMap(databaseId) {
  if (!databaseId) return null;

  const map = new Map();
  let cursor = undefined;

  do {
    const body = cursor
      ? { start_cursor: cursor }
      : {};
    const res = await notionFetch(
      `/databases/${databaseId}/query`,
      { method: "POST", body }
    );

    for (const page of res.results || []) {
      const prop = page.properties?.[VERSIONS_NAME_PROP];
      const titleObj = prop && prop.type === "title" ? prop.title : [];
      const titleText =
        titleObj && titleObj[0] && titleObj[0].plain_text
          ? titleObj[0].plain_text.trim()
          : "";
      if (titleText) {
        map.set(titleText, page.id);
      }
    }

    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return map;
}

async function queryByPath({ dataSourceId, pathValue }) {
  const filter = {
    property: PROPS.path,
    rich_text: { equals: pathValue },
  };

  if (dataSourceId) {
    return notionFetch(
      `/data_sources/${dataSourceId}/query`,
      { method: "POST", body: { filter, page_size: 1 } }
    );
  }
  return notionFetch(`/databases/${NOTION_DATABASE_ID}/query`, {
    method: "POST",
    body: { filter, page_size: 1 },
  });
}

// Extract ADR metadata from markdown content
function parseAdrMetadata(markdown) {
  if (!markdown || typeof markdown !== "string") {
    return {
      adrId: "",
      adrTitle: "",
      status: "",
      date: "",
      appliesRaw: "",
      appliesTokens: [],
      supersededBy: "",
    };
  }

  // H1: "# ADR-0005 – Title" or "# ADR-0005: Title"
  const h1Match = markdown.match(
    /^#\s*(ADR-\d+)\s*[–\-:]\s*(.+)$/m
  );
  const adrId = h1Match ? h1Match[1].trim() : "";
  const adrTitle = h1Match ? h1Match[2].trim() : "";

  function extract(field) {
    const re = new RegExp(
      `^\\*${field}:\\*\\s*(.+)$`,
      "mi"
    );
    const m = markdown.match(re);
    return m ? m[1].trim() : "";
  }

  const statusRaw = extract("Status");
  const status = statusRaw.split("(")[0].trim(); // drop bracket comments

  const date = extract("Date");

  const appliesRaw = extract("Applies to");
  const appliesTokens = appliesRaw
    .split(/[,+/&]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const supersededRaw = extract("Superseded by");
  const supersededBy = supersededRaw
    .split("(")[0]
    .trim();

  return {
    adrId,
    adrTitle,
    status,
    date,
    appliesRaw,
    appliesTokens,
    supersededBy,
  };
}

// Build the Notion properties for a given file/path + SHA
function buildProperties(pathValue, shaValue, versionsMap) {
  const fileName = pathValue.split("/").pop() || pathValue;
  const defaultTitle = fileName.replace(/\.[^.]+$/, "");
  const url = `https://github.com/${owner}/${repo}/blob/${GH_REF_NAME}/${pathValue}`;

  const properties = {
    [PROPS.title]: {
      title: [{ text: { content: defaultTitle } }],
    },
    [PROPS.path]: {
      rich_text: [{ text: { content: pathValue } }],
    },
    [PROPS.repo]: {
      rich_text: [{ text: { content: `${owner}/${repo}` } }],
    },
    [PROPS.url]: { url },
    [PROPS.sha]: {
      rich_text: [{ text: { content: shaValue } }],
    },
  };

  // Try to parse ADR metadata; if it fails or file is not an ADR, these stay empty.
  let markdown = "";
  try {
    markdown = fs.readFileSync(pathValue, "utf8");
  } catch (e) {
    // It's ok if we can't read (e.g., non-ADR or missing); just return base props.
    return properties;
  }

  const meta = parseAdrMetadata(markdown);

  // If this isn't an ADR (no ADR-XXXX heading), bail out with base properties.
  if (!meta.adrId) {
    return properties;
  }

  // ADR ID
  properties[PROPS.adrId] = {
    rich_text: [{ text: { content: meta.adrId } }],
  };

  // ADR Title (human title)
  if (meta.adrTitle) {
    properties[PROPS.adrTitle] = {
      rich_text: [{ text: { content: meta.adrTitle } }],
    };
  }

  // Date
  if (meta.date) {
    properties[PROPS.adrDate] = {
      date: { start: meta.date },
    };
  }

// Status (Notion "status" type, bare value w/o comments)
if (meta.status) {
  properties[PROPS.adrStatus] = {
    status: { name: meta.status },
  };
}

  // Superseded by
  if (meta.supersededBy) {
    properties[PROPS.adrSupersededBy] = {
      rich_text: [
        { text: { content: meta.supersededBy } },
      ],
    };
  }

  // Applies to (text)
  if (meta.appliesRaw) {
    properties[PROPS.adrAppliesText] = {
      rich_text: [
        { text: { content: meta.appliesRaw } },
      ],
    };
  }

  // Applies to (relation)
  if (
    versionsMap &&
    meta.appliesTokens &&
    meta.appliesTokens.length > 0
  ) {
    const relationValues = [];
    for (const token of meta.appliesTokens) {
      const pageId = versionsMap.get(token);
      if (pageId) {
        relationValues.push({ id: pageId });
      } else {
        // Optional: log unmatched tokens
        console.warn(
          `No LEH version page found for token "${token}" (Applies to) in ${pathValue}`
        );
      }
    }
    if (relationValues.length > 0) {
      properties[PROPS.adrAppliesRel] = {
        relation: relationValues,
      };
    }
  }

  return properties;
}

async function createOrUpdate({
  dataSourceId,
  pathValue,
  shaValue,
  versionsMap,
}) {
  const q = await queryByPath({ dataSourceId, pathValue });
  const existing = q.results?.[0];

  const properties = buildProperties(
    pathValue,
    shaValue,
    versionsMap
  );

  if (!existing) {
    // Create page in database/data source.
    const parent = dataSourceId
      ? {
          type: "data_source_id",
          data_source_id: dataSourceId,
        }
      : { database_id: NOTION_DATABASE_ID };

    await notionFetch(`/pages`, {
      method: "POST",
      body: { parent, properties },
    });
    return { action: "created", path: pathValue };
  }

  // If SHA unchanged, skip update.
  const currentSha =
    existing.properties?.[PROPS.sha]?.rich_text?.[0]
      ?.plain_text || "";
  if (currentSha === shaValue) {
    return { action: "skipped", path: pathValue };
  }

  await notionFetch(`/pages/${existing.id}`, {
    method: "PATCH",
    body: { properties },
  });
  return { action: "updated", path: pathValue };
}

async function run() {
  // FULL_SYNC path (initial sync) OR when we don't have a meaningful BEFORE SHA
  const dataSourceId = await getDataSourceId(
    NOTION_DATABASE_ID
  );

  let versionsMap = null;
  if (NOTION_LEH_VERSIONS_DB_ID) {
    try {
      versionsMap = await fetchVersionsMap(
        NOTION_LEH_VERSIONS_DB_ID
      );
    } catch (e) {
      console.warn(
        "Failed to fetch LEH versions DB; Applies-to relations will not be set:",
        e.message
      );
      versionsMap = null;
    }
  }

  if (FULL_SYNC || !BEFORE) {
    const out = execSync(
      `git ls-tree -r ${AFTER} -- ${DOCS_ROOT}`,
      { encoding: "utf8" }
    )
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
      .filter(
        (x) =>
          x.type === "blob" &&
          x.path.startsWith(DOCS_ROOT) &&
          (x.path.endsWith(".md") ||
            x.path.endsWith(".mdc"))
      );

    if (files.length === 0) {
      console.log(`No files found under ${DOCS_ROOT}`);
      return;
    }

    for (const f of files) {
      const r = await createOrUpdate({
        dataSourceId,
        pathValue: f.path,
        shaValue: f.sha,
        versionsMap,
      });
      console.log(`${r.action}: ${r.path}`);
    }

    return;
  }

  // Get changed files from git diff
  const diff = execSync(
    `git diff --name-status ${BEFORE} ${AFTER} -- ${DOCS_ROOT}`,
    { encoding: "utf8" }
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  const candidates = diff
    .map((line) => {
      const parts = line.split(/\s+/);
      const status = parts[0];

      // Rename/Copy: "R100 old new" or "C100 old new"
      if (status.startsWith("R") || status.startsWith("C")) {
        return {
          status,
          oldFile: parts[1],
          file: parts[2],
        };
      }

      // Add/Modify/Delete: "A file", "M file", "D file"
      return { status, file: parts[1] };
    })
    .filter((x) => {
      const p = x.file || "";
      const old = x.oldFile || "";
      const relevant = p.startsWith(DOCS_ROOT)
        ? p
        : old.startsWith(DOCS_ROOT)
        ? old
        : "";
      return (
        relevant &&
        (relevant.endsWith(".md") ||
          relevant.endsWith(".mdc"))
      );
    });

  if (candidates.length === 0) {
    console.log("No docs changes.");
    return;
  }

  // Helpers for deleted / renamed
  async function archiveByPath(pathValue) {
    const q = await queryByPath({ dataSourceId, pathValue });
    const existing = q.results?.[0];
    if (!existing) return { action: "missing", path: pathValue };

    await notionFetch(`/pages/${existing.id}`, {
      method: "PATCH",
      body: { archived: true },
    });
    return { action: "archived", path: pathValue };
  }

  async function renameByPath(
    oldPath,
    newPath,
    shaValue
  ) {
    const q = await queryByPath({
      dataSourceId,
      pathValue: oldPath,
    });
    const existing = q.results?.[0];

    // If we can't find the old row, just upsert the new path
    if (!existing) {
      return createOrUpdate({
        dataSourceId,
        pathValue: newPath,
        shaValue,
        versionsMap,
      });
    }

    const properties = buildProperties(
      newPath,
      shaValue,
      versionsMap
    );

    await notionFetch(`/pages/${existing.id}`, {
      method: "PATCH",
      body: { properties },
    });
    return { action: "renamed", path: newPath };
  }

  // For each changed file, compute blob SHA using git
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

    // Renamed file -> update existing Notion row (keep status etc.)
    if (status.startsWith("R") && oldFile) {
      // If moved out of DOCS_ROOT, archive the old one
      if (!file || !file.startsWith(DOCS_ROOT)) {
        const r = await archiveByPath(oldFile);
        console.log(`${r.action}: ${r.path}`);
        continue;
      }

      let sha = "";
      try {
        sha = execSync(
          `git rev-parse ${AFTER}:${file}`,
          { encoding: "utf8" }
        ).trim();
      } catch {
        console.log(
          `skip ${file}: cannot resolve blob sha at ${AFTER}`
        );
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
      sha = execSync(
        `git rev-parse ${AFTER}:${file}`,
        { encoding: "utf8" }
      ).trim();
    } catch {
      console.log(
        `skip ${file}: cannot resolve blob sha at ${AFTER}`
      );
      continue;
    }

    const r = await createOrUpdate({
      dataSourceId,
      pathValue: file,
      shaValue: sha,
      versionsMap,
    });
    console.log(`${r.action}: ${r.path}`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
