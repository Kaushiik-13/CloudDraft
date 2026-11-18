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

Run `corepack pnpm icons:cloud` once with curl and internet access to install every
icon listed in the [AWS and Google Cloud sections of Eraser's catalog](https://docs.eraser.io/icons).
The SVGs and a searchable list of names are saved in `icons/cloud/`.
Copy that directory with the project for offline use. The renderer checks your
custom icon directory first, then uses the installed cloud catalog.

Try `corepack pnpm architecture examples/multi-cloud.eraserdiagram` for
API Gateway, Lambda, S3, Pub/Sub, Cloud Run, and BigQuery in one diagram.
