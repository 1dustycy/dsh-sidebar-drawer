## Agent skills

### Issue tracker

Issues live as GitHub issues on `1dustycy/dsh-sidebar-drawer`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to same-named GitHub labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Documentation language

`README.md` is the only outward-facing document, so it is bilingual and the two halves ship together:

- `README.md` — Simplified Chinese; `README.en.md` — English.
- Each opens with switcher links (`English | 简体中文`) directly under the title: the current
  language is plain text, the other one is the link.
- Change both in the same commit and keep them in step — never update one half and leave the
  other stale. Terms follow `CONTEXT.md` (Chinese wording ↔ code identifiers) rather than being
  re-invented per language.

Everything else is internal, written for maintainers and agents, and stays Simplified Chinese:
`docs/`, `CONTEXT.md`, and `AGENTS.md`'s own references. Do not translate them and do not add
English mirrors — the English README may label those links as Chinese instead.
