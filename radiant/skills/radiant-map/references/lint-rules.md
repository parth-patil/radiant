# Lint rules

`radiant lint MAP --json` returns `issues`: `{ rule, severity, ids, message, hint }`. Lint exits 0 unless `--fail-on` is given. The layout rules run on the headless layout report (`radiant layout`), whose text metrics are approximate; the result says `engine: "headless"` and `metrics: "approximate"`. The presentation rules run with `--presentation NAME`.

| Rule | Severity | Fires when | Fix |
|---|---|---|---|
| empty-label | error | A node has no text and no picture. | Give it a label or a picture, or delete it. |
| dangling-link | error | A cross-link names a missing node. | Remove the link. |
| long-label | warn | More than 6 words (`--max-words`). | Keep a keyword; move the rest to the note or a child. |
| wide-fanout | warn | More than 9 children (`--max-children`). | Group children under intermediate nodes. |
| duplicate-sibling | warn | Two children of one parent share a label. | Merge them or make the labels distinct. |
| low-contrast | warn | Text against its fill or the canvas is below 4.5:1 (`--min-contrast`). | Change `text=` or `fill=`, or the theme. |
| deep-chain | info | 4 or more single children in a row (`--chain`). | Merge the chain or use a note. |
| adjacent-colour | info | Neighbouring main branches have near-identical colours. | Set `color=` on one of them. |
| missing-alt | info | A picture has no alt text. | Add `alt="…"`. |
| overlap | error | Two visible node boxes intersect (usually manual offsets, pins or neighbouring roots). | `set {"offset": null}`, move a branch to the other side, or move a root. |
| long-label (lines) | warn | A label wraps to more than 2 lines (`--max-lines`). | Shorten the label. |
| tiny-in-render | warn | At `--max-edge` pixels (default 1,568) the smallest labels would be under 9 px. | Render a branch (`--node`), or fold deep levels. |
| unbalanced | info | One side of a mindmap root is over 1.6 times the height of the other. | Move a main branch with `set {"side": …}`, or fold it. |
| extreme-aspect | info | The map is more than 3 times wider than tall, or the reverse. | Try another layout. |
| element-overlap | info | A canvas shape, note, text or picture overlaps a node (ids: element, node). | Move it with `canvas-set`, or `canvas-order {"band": "back"}`. |
| step-broken | error | A presentation step has no nodes or elements left. | Give it new focus ids, or delete the step. |
| step-reveal | warn | A step reveals more than 7 nodes at once. | Split the step, or `build=each`. |
| step-long-label | warn | A focus label has more than 6 words. | Shorten it, or give the step a title. |
| step-jump | warn | The camera moves more than 1.5 screens (at 1440 x 900) between steps. | Add a step in between, or `frame=map`. |
| unvisited-branch | info | No step visits a main branch. | Add a step that focuses or reveals it. |
