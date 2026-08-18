# The accessibility tree is the targeting contract; Playwright is only transport

A Locator identifies a control by accessibility role plus accessible name, optionally scoped by a
parent Locator. Playwright executes those Locators via `getByRole`, but CSS and XPath expressions
are banned from the codebase entirely. The accessibility tree is the only representation that
exists on both browsers (ARIA) and desktop platforms (UIA on Windows, AX on macOS), so it is the
one targeting vocabulary that survives the move to a non-browser Surface that the brief asks us to
design for — whereas a CSS selector is meaningless outside a DOM.

## Considered Options

- **Screenshot plus coordinates.** Generalises to desktop, but coordinates break on window size,
  scroll offset, and theme. Deterministic Replay is a top-weighted criterion, and pixel targeting
  fights it directly.
- **CSS / XPath selectors.** Replay reliably, but assume the clean DOM the brief says is the
  uncommon case, and cannot cross to a desktop Surface at all.

## Consequences

Seeing Playwright in the dependency list, a reader will reasonably assume CSS selectors are
available and may add one to fix a flaky Locator. That would silently destroy the portability claim
this project's §3.7 answer rests on. The ban is deliberate — enforce it in review.
