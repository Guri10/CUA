/**
 * The ARIA role vocabulary — the first half of what ADR 0001 makes the targeting
 * contract, the accessible name being the other half.
 *
 * It is a closed list here rather than a bare string for two reasons. A typo in
 * a Locator's role is caught at compile time instead of becoming a control that
 * is never found at replay time, and this list is a subset of the roles
 * Playwright's `getByRole` accepts, so the Playwright Surface passes a role
 * straight through with no cast. It is the accessibility vocabulary that owns
 * this list, not Playwright — a desktop Surface reading UIA or AX would map
 * onto the same names.
 */
export const ARIA_ROLES = [
  "alert", "alertdialog", "application", "article", "banner", "blockquote",
  "button", "caption", "cell", "checkbox", "code", "columnheader", "combobox",
  "complementary", "contentinfo", "definition", "deletion", "dialog",
  "directory", "document", "emphasis", "feed", "figure", "form", "generic",
  "grid", "gridcell", "group", "heading", "img", "insertion", "link", "list",
  "listbox", "listitem", "log", "main", "marquee", "math", "meter", "menu",
  "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation",
  "none", "note", "option", "paragraph", "presentation", "progressbar",
  "radio", "radiogroup", "region", "row", "rowgroup", "rowheader",
  "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton",
  "status", "strong", "subscript", "superscript", "switch", "tab", "table",
  "tablist", "tabpanel", "term", "textbox", "time", "timer", "toolbar",
  "tooltip", "tree", "treegrid", "treeitem",] as const;

export type AriaRole = (typeof ARIA_ROLES)[number];
