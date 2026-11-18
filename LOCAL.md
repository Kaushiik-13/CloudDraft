# Local architecture renderer

This branch trims the upstream repository to the local engine and CLI. It uses
the Eraser templates, fonts, and connector routing, and places diagram elements
in source order within each group.

Install Node and Chromium, then run from the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm architecture examples/architecture.eraserdiagram
```

Set `CHROMIUM_PATH` if Chromium is installed somewhere other than
`/usr/bin/chromium`. The command writes PNG and standalone HTML to `exports/`.
Pass a second argument to choose a different export folder.

The input supports node declarations, nested groups, labels, colors, local SVG
icons, `direction right` and `direction down`, and labeled connections using
`>`, `<`, `<>`, or `--`. Declare both ends before rendering. Use one
statement per line. Put icon files in `icons/` or set `ARCHITECTURE_ICONS`
to use another local folder. The example bundles an original database icon.

Rendering uses local files after setup. Hosted Eraser syntax and layout parity,
a live editor, and SVG and PDF exports are outside this prototype.

## AWS and Google Cloud icons

The repository includes the AWS and Google Cloud SVGs and a list of their
names in `icons/cloud/`. The renderer checks your custom icon directory first,
then uses the bundled catalog. To update the catalog, run
`corepack pnpm icons:cloud` with curl and internet access.

Try `corepack pnpm architecture examples/multi-cloud.eraserdiagram` for
API Gateway, Lambda, S3, Pub/Sub, Cloud Run, and BigQuery in one diagram.
