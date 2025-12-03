# ADR-0001: GitHub as source of truth; Notion as hub

*Status:* Accepted  
*Date:* 2025-10-29  
*Applies to:* LEHv1, LEHv2

## Context

We need one canonical place for code and versioned docs, and a simple project hub for humans.

## Decision

- GitHub repo stores code, schemas, strategy versions, and ADRs.
- Notion has a single “Hub” page with quick links, strategy table, ADR index, and backlog.

## Consequences

- One URL per decision/version (shareable in AI chats).
- Non-technical notes live in Notion, but anything versioned lives in GitHub.
