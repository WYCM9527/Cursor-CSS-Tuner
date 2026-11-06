# Changelog

## 0.11.0

- Pick a font: the Text section now starts with a Font field. It opens a searchable list of your theme's fonts (Tailwind's `font-*`, or CSS variables that hold a font stack in plain CSS projects), fonts the page loads with `@font-face`, fonts installed on your computer and generic families. Each name is shown in its own typeface, and hovering one or moving to it with the arrow keys previews it on the page. To use a font that isn't listed, type its name or a whole font stack.
- When you pick a font that's only installed on your computer, the prompt says the page doesn't load it.
- Installed fonts are read on your computer the first time you open the Font menu: from the system font manager on macOS, with PowerShell on Windows and with `fc-list` on Linux.
- Closing a dropdown with Esc or a click elsewhere after hovering its options no longer leaves the field marked as changed.

## 0.10.1

- Prompts for the Agent are much shorter. A prompt opens with the page, gives one item per element with where it is and each change as old value → new value (several changes to the same element share one item), and ends with just two requests: consider whether other affected places should change too, asking you when unsure, and list what was changed. The detailed instructions are gone, such as which tokens to prefer, how to write breakpoint prefixes or `@media`, and where to change props. Revert prompts use the same format with the arrows reversed.
- Properties edited together are written as CSS shorthands in the prompt, for example `padding-inline` instead of `padding-left / padding-right`.
- For an element the extension can't map to your source, the prompt adds the element's text after its name, so elements with the same name and page position can be told apart.

## 0.10.0

- Apply now hands every change to the Agent, and the extension no longer edits your files itself. Apply and Apply All put a prompt into a new Agent chat; review it and press Enter to send it (it's copied to the clipboard too). The prompt says where each change is in your code and what it should become, without prescribing how to write it.
- The page keeps showing the preview while the Agent works. Once the Agent has changed the code and the page has updated, the panel checks the page against the preview and marks the change *Applied*. If the page shows something else, the change says what it shows now, and *Send Again* adds that to the prompt.
- Revert goes through the Agent too. *Compare* shows your file from when the change was handed off next to the file now.
- A change is *Not applied*, *Waiting for the Agent*, *Applied*, *Waiting for the Agent to revert* or *Reverted*. *Discard* on a change that's still waiting removes it from the list and its preview from the page; *Don't Revert* stops waiting for a revert.
- Removed the settings that only controlled writing back directly (`cssTuner.tailwind.arbitraryValues`, `cssTuner.css.strategy`, `cssTuner.vars.strategy`, `cssTuner.verifyTimeoutMs`) and the *Hand Remaining Changes to Agent* command, which Apply All now covers.
- Images & video: a new section (after Variables, folded by default) lists the images, background images, SVGs and videos you can see in the selected element. Save one with *Save As…*, save them all into a folder with *Download All* (duplicate names get a number), copy an SVG's code, or find the file in your project. Images with a `srcset` are saved at their largest size. Saved SVG files use the colors shown on the page, while the copied code keeps `currentColor`. Streaming videos (MediaSource, HLS, DASH) can't be downloaded, but their poster can.
- Ruler: measures the distance between the hovered element and the selected one, with the spacing scale's name next to each number. Click to select the hovered element, and press Esc to leave. With the ruler off, hold Alt while hovering. It's on the panel's toolbar and in the *Ruler: Measure Distances* command.
- Viewport: view the page at phone (390px), tablet or desktop width; the tablet and desktop widths come from your theme's `md` and `lg` breakpoints. A page that doesn't fit is scaled down. The width stays when the page reloads or changes, and goes back when the panel is folded or closed.
- With Phone, Tablet or Desktop picked, style changes only apply to that range of widths. The prompt asks for a breakpoint prefix in Tailwind (putting the original value back for wider widths when the base class changes) and for `@media` in plain CSS. The preview only shows at those widths, and the check switches the page to them.
- Fixed: when hot reload replaced a stylesheet, the preview of a change waiting for the Agent disappeared.

## 0.9.0

- Gradients for fill and stroke: the color popover switches between Solid, Linear and Radial. Set the angle (type it, or rotate by 90°), click the gradient bar to add a color stop, drag stops to move them, and press Delete to remove the selected one (at least two stay). The color picker below recolors the selected stop and offers your theme colors.
- Gradients are written back as:
  - Tailwind 4: `bg-linear-*` / `bg-radial` with `from-*` / `via-*` / `to-*`, using your theme's color names where a stop matches.
  - Tailwind 3: `bg-gradient-to-*` with `from-*` / `via-*` / `to-*`. Other angles use `bg-[linear-gradient(45deg,var(--tw-gradient-stops))]`.
  - An arbitrary value when standard classes can't express the gradient.
  - CSS: `background-image`, keeping `var()` colors. A `background` shorthand that only set the color is removed.
- Gradient strokes keep rounded corners. When the element has an opaque fill, the stroke is drawn with two background layers and transparent border colors. Without one, the change goes to the Agent, which is asked to keep the corners and leave the inside transparent; the preview draws the color behind the element underneath, so it looks like the result. Gradient strokes are always solid.
- Images, conic gradients and multi-layer backgrounds show up in the fill as *Background image*. Switching to a solid color or gradient replaces them.
- Fixed: a color stop added between a color and transparent came out too dark. Gradient colors are now mixed the way the browser mixes them.
- Fixed: after reverting a multi-layer background, `background-clip` and `background-origin` were reported as not taking effect.

## 0.8.0

- Undo and redo: the change list and Apply All now sit at the top of the panel, with Undo and Redo right next to Apply All (or ⌘Z / ⇧⌘Z, Ctrl+Z / Ctrl+Shift+Z, in the panel). They step through the changes you haven't applied yet, and the change list follows along. The list is folded into one line by default.
- Reset a field: a value with an unapplied change shows a reset button in its corner. This works for styles, text, order and props.
- Stroke: a new section for border width, style and color. Tailwind gets `border` classes, and a CSS `border` shorthand is edited part by part. Shadow now has its own section.
- Add and remove properties: an element with no fill, stroke or shadow gets one from the + on that section, and − takes it away. A value that comes from a declaration in your code has a × that removes it: the declaration is deleted in CSS (when a box or border shorthand also sets properties you keep, the rest is written out as longhands), and the class is removed in Tailwind. The page previews the element without it, and changes handed to the Agent ask for the declaration to be removed.
- A property that isn't declared yet is added to a rule outside `@media` and other conditions when there is one, so it applies at every width.
- Plainer panel: the selected element is named in words with the start of its text (for example *Heading “Welcome”*), next to the file it's written in. The Structure tree is now called Layers and uses the same names, with Move up / Move down and the element's position below it. *This one* / *All* only appears when the two would change different places in your code, and *All* says how many elements it affects. Labels and hints throughout avoid jargon.
- Switch between English and Simplified Chinese with 中 / EN at the top of the panel. The choice is saved in the new `cssTuner.language` setting.
- Fixed: after a preview removed a declaration from a rule, the next snapshot no longer saw the original declaration; resetting only the stroke width was reported as not taking effect.

## 0.7.0

- Vue 3 and Svelte 5, styles only: pick elements on Vue 3 + Vite, Nuxt 4, Svelte 5 + Vite and SvelteKit pages, and write style changes back into `.vue` and `.svelte` files:
  - Classes in the `class` attribute, `:class` strings, arrays and object literals, `class:` directives, and the `class` written where a component is used.
  - Rules in `<style>` and `<style scoped>` blocks. Selectors with `:deep()`, `:global()` and similar are matched as written.
- In Vue and Svelte components, text, reordering and props go to the Agent. Elements rendered by components from `node_modules` map to where your code uses the component, and Nuxt and SvelteKit pages are read once they have hydrated.
- Tailwind 3: the theme is read from `tailwind.config` with the project's own `tailwindcss`, and classes are written back the same way as in Tailwind 4.
- Next.js webpack dev mode (`next dev --webpack`): source locations for server and client components and CSS files. When a write makes the page reload completely, verification waits for it to reconnect.
- Fixed: reordering items that share a row in normal flow (such as a row of buttons under a heading), or that wrap onto the next line, didn't move them in the preview.

## 0.5.0

- Reorder elements among their siblings: drag the handle on the selected element (an insertion line shows where it lands), drag rows in the Structure tree, or use Move up / Move down. The page previews the new order with `order` or transforms before anything is written.
- Reordering is written back deterministically:
  - JSX children, keeping comments with the element they belong to. For server components the call site is changed.
  - Constant arrays rendered with `.map()`: `as const` literals, constants in the same scope, and constants imported from a relative path.
  - Children in plain HTML files.
- Edit component props: the new Props section lists the props passed at the selected component's call site. Variants from `cva` / `tailwind-variants` and TypeScript string literal unions are offered as options, including variants that aren't passed yet.
- Props preview live on the page for client components in React 18 / 19 and Next.js, and only for this call site. Server components can't be previewed; their props change once written back. A page that was open before the extension connected needs one reload.
- Props are written back at the call site: literal values are changed in place and missing props are added; values set by expressions go to the Agent. A warning is shown when a spread (`{...props}`) could override the value.
- Fixed: with React 18 and `@vitejs/plugin-react` 4, source locations were about 19 lines off, so changes went to the Agent instead of being written back.
- Fixed: pending changes could disappear from the panel when the selection was rebuilt during an edit; in a workspace with several projects, a path that exists in more than one of them could point the page at the wrong project; the dev server could read an empty file in the middle of a write.

## 0.3.0

- Edit text: the new Content section lists the selected element's text, split into runs around inline tags such as `<b>`. Edit a run in the panel, or double-click text inside the selected element on the page and type in place. Enter adds the change to the list; Esc undoes it.
- Text is written back deterministically:
  - JSX text in the element itself.
  - The string passed in at a component's call site (`title="…"` or children), so only that use changes.
  - Messages from `t('key')` in react-i18next and next-intl JSON files, in the language shown on the page (taken from the route, then `<html lang>`).
  - Text in plain HTML files, with characters such as `&` and `<` escaped again.
- Text produced by code (expressions, template strings, custom translation helpers, `t.rich`) goes to the Agent together with the code it comes from.
- After applying, the page's text is verified as well, including after the full page reload Vite does when a message file changes.

## 0.2.0

- English and Simplified Chinese: the panel, notifications, the reasons shown when a change can't be written back, and prompts handed to the Agent follow Cursor's display language. Command names and settings descriptions are translated too.
- English store page with a Chinese version, a demo GIF and a screenshot.

## 0.1.0 (preview)

First usable release.

- Pick elements in Cursor's built-in browser: hover highlight, breadcrumb, component tree and same-source instance markers.
- Tuning panel: layout (flex / grid), spacing, size, position, text, fill, radius, effects and CSS variables, with scale snapping; hold Alt for exact values.
- Deterministic write-back:
  - Tailwind 4 classes (literals, template literals, `clsx` / `cn` / `twMerge`, `cva` variants, class-name constants, component call sites). Only the active responsive variant is changed, and off-scale values become arbitrary-value classes.
  - Plain CSS rules (shorthands, nesting, `@import`, CSS Modules).
  - CSS variable definitions (`:root`, `@theme`).
- After applying, waits for hot reload and verifies computed styles, with another round in the background when hot reload is slow.
- Revert one change at a time: byte-for-byte restore, or roll back only this change if the source changed since; stops and shows a diff when it can't.
- Changes that can't be written back become a prompt prefilled in a new Agent chat.
- Plain HTML projects open with a built-in static server.
- Next.js 16 App Router (Turbopack dev mode): source locations for server and client components, `globals.css` and CSS Modules.
- Checks at startup that the built-in browser commands are available; "CSS Tuner: Self-Check" runs the full flow in a separate tab.
