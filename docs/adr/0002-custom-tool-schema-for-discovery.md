# Discovery uses our own tool schema, not Anthropic's computer-use tool

During a Discovery Run the model acts through tools we define — `click`, `fill`, `select`, `read`,
`wait_for`, `done` — each addressing an accessibility node reference rather than a screen
coordinate. These verbs are deliberately identical to the Step vocabulary of a Recording, so
producing a Recording is a filter over the successful tool calls rather than a translation of a
model transcript into some other shape.

## Considered Options

- **Anthropic's server-defined computer-use tool.** Less code to write, but it acts on pixel
  coordinates, which [[0001-accessibility-tree-is-the-targeting-contract]] rules out as a Locator
  strategy. It would leave us translating coordinate actions into role/name Locators after the
  fact, guessing at what the model meant to click.

## Consequences

Owning the tool handlers gives us the single enforcement point that
[[0007-risk-is-classified-statically-not-by-the-model]] depends on: every action the model attempts
passes through our code before it reaches the Surface, so the policy gate has somewhere to live.
A server-side tool would have no such seam.
